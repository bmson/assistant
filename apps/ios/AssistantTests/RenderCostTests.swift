import XCTest
@testable import Assistant

/// The transcript draws every row it has, and it redraws on every streamed
/// token, every keystroke in the composer, and every point of a pull-menu drag.
/// These cover the three things that keep that affordable: the work is
/// remembered rather than redone, the facts a row needs about the rest of the
/// log are resolved once, and a row whose content has not changed compares
/// equal so SwiftUI can skip it.
///
/// They are correctness tests, not benchmarks. What each one pins down is that
/// the cheap path gives the same answer as the expensive one it replaced.
final class RenderCostTests: XCTestCase {

    // MARK: - RenderMemo

    func testMemoComputesOncePerKey() {
        let memo = RenderMemo<String, Int>(limit: 8)
        var calls = 0
        let count = { (key: String) -> Int in
            calls += 1
            return key.count
        }

        XCTAssertEqual(memo.value(for: "abc", compute: count), 3)
        XCTAssertEqual(memo.value(for: "abc", compute: count), 3)
        XCTAssertEqual(memo.value(for: "abcd", compute: count), 4)
        XCTAssertEqual(memo.value(for: "abc", compute: count), 3)

        XCTAssertEqual(calls, 2, "A repeated key must not be recomputed")
    }

    func testMemoStaysWithinItsLimitAndKeepsTheNewestKeys() {
        let memo = RenderMemo<Int, Int>(limit: 4)
        for key in 0..<64 {
            _ = memo.value(for: key) { $0 * 2 }
        }

        // The most recent key survived eviction, so a transcript being read at
        // its newest edge keeps hitting.
        var calls = 0
        let doubled = memo.value(for: 63) { key -> Int in
            calls += 1
            return key * 2
        }
        XCTAssertEqual(doubled, 126)
        XCTAssertEqual(calls, 0)
    }

    func testMemoRemembersAFailureAsWellAsAValue() {
        let memo = RenderMemo<String, String?>(limit: 4)
        var calls = 0
        let parse = { (_: String) -> String? in
            calls += 1
            return nil
        }

        XCTAssertNil(memo.value(for: "(", compute: parse))
        XCTAssertNil(memo.value(for: "(", compute: parse))
        XCTAssertEqual(calls, 1)
    }

    func testCachedExpressionIsReusedAndStillMatches() {
        let first = NSRegularExpression.cached(#"(\d+) items?"#)
        let second = NSRegularExpression.cached(#"(\d+) items?"#)
        XCTAssertNotNil(first)
        XCTAssertTrue(first === second, "A pattern should be compiled once")

        let text = "12 items"
        XCTAssertNotNil(first?.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)))

        // Options are part of the identity: the same pattern read two ways is
        // two expressions.
        XCTAssertFalse(first === NSRegularExpression.cached(#"(\d+) items?"#, options: [.caseInsensitive]))
        XCTAssertNil(NSRegularExpression.cached("([unclosed"))
    }

    // MARK: - Markdown

    func testRepeatedBlockParsesAgree() {
        let source = """
        # Heading

        A paragraph with **bold** text.

        - one
          - nested
        - two

        | A | B |
        | --- | --- |
        | 1 | 2 |
        """

        let first = AssistantMarkdown.blocks(in: source)
        let second = AssistantMarkdown.blocks(in: source)
        XCTAssertEqual(first, second)
        XCTAssertEqual(first.count, 4)
    }

    /// `markdownText` used to build this inline; the memoised entry point has to
    /// read the source the same way, including the preprocessing that runs
    /// before `AttributedString` sees it.
    func testAttributedReadsBlockAndInlineSourcesAsBefore() {
        let expected: (String, Bool) -> AttributedString = { source, inline in
            let readable = AssistantMarkdown.readableInlineVariables(source)
            let withBreaks = inline
                ? AssistantMarkdown.tableCellText(readable)
                : AssistantMarkdown.preservingSoftBreaks(readable)
            return (try? AttributedString(
                markdown: withBreaks,
                options: .init(
                    interpretedSyntax: inline ? .inlineOnlyPreservingWhitespace : .full
                )
            )) ?? AttributedString(source)
        }

        for source in [
            "A line\nand the next one",
            "Cell **one**<br>Cell two",
            "The variable $x$ stands alone",
            "`$y$` stays in its code span",
            "",
        ] {
            for inline in [true, false] {
                XCTAssertEqual(
                    AssistantMarkdown.attributed(source, inline: inline),
                    expected(source, inline),
                    "source: \(source), inline: \(inline)"
                )
            }
        }
    }

    func testSingleLineBreakSurvivesBlockInterpretation() {
        let attributed = AssistantMarkdown.attributed("first\nsecond", inline: false)
        XCTAssertTrue(String(attributed.characters).contains("\n"))
    }

    func testPlainTextDropsMarkdownSyntax() {
        XCTAssertEqual(
            AssistantMarkdown.plainText("Book **the** [room](https://example.com)"),
            "Book the room"
        )
        XCTAssertEqual(AssistantMarkdown.plainText("Book **the** room"), "Book the room")
    }

    // MARK: - TranscriptContext

    /// The prompt for each row must agree with a backwards scan of the log.
    func testContextAgreesWithTheScansItReplaced() {
        let log: [ChatMessage] = [
            .optimistic(role: .assistant, text: "Morning.", id: "a1"),
            .optimistic(role: .user, text: "Book the room", id: "u1"),
            .optimistic(role: .assistant, text: "Booked.", id: "a2"),
            .optimistic(role: .user, text: "And tell Ana", id: "u2"),
            ChatMessage(id: "a3", role: .assistant, parts: [
                .init(type: "notice", text: "That one needs your approval."),
            ]),
            .optimistic(role: .assistant, text: "Told her.", id: "a4"),
        ]
        let context = TranscriptContext(messages: log)

        for index in log.indices {
            XCTAssertEqual(
                context.userPrompt(before: index),
                log[..<index].reversed().first(where: { $0.role == .user })?.text,
                "prompt at \(index)"
            )
        }

        XCTAssertEqual(context.userPrompt(before: 5), "And tell Ana")
        XCTAssertNil(context.userPrompt(before: 0))
    }

    func testContextIsEmptyForAnEmptyLog() {
        let context = TranscriptContext(messages: [])
        XCTAssertNil(context.userPrompt(before: 0))
    }

    // MARK: - Row equality

    func testTranscriptBoundaryNoticesTokensDecisionsAndSendAvailability() {
        let rows = { (messages: [ChatMessage], sending: Bool) in
            ChatTranscriptRows(
                messages: messages, isSending: sending,
                openApprovals: {}, send: { _, _ in },
                decideApproval: { _, _ in false }, rememberApproval: { _ in false },
                decideSuggestion: { _, _ in nil }, openActivity: {},
                refreshCard: { _, _ in nil }, hideMessage: { _ in },
                setRecallSourceSuppressed: { _, _, _ in .failed },
                recallSourceSuppressed: { _ , _ in nil },
                acknowledgeMessageDelivery: { _ in false },
                cardFormActions: nil,
                cardFormStateRevision: 0,
                cardFormTaskRevision: 0
            )
        }
        let message = ChatMessage.optimistic(role: .assistant, text: "Half a reply", id: "stream-1")
        XCTAssertEqual(rows([message], true), rows([message], true))
        XCTAssertNotEqual(rows([message], true), rows([message], false))

        var grown = message
        grown.parts[0].text = "Half a reply, then the rest"
        XCTAssertNotEqual(rows([message], true), rows([grown], true))

        let pending = ChatMessage(id: "decision", role: .assistant, parts: [.init(type: "approval", status: "pending")])
        var approved = pending
        approved.parts[0].status = "approved"
        XCTAssertNotEqual(rows([pending], false), rows([approved], false))
    }

    func testRowComparesEqualOnlyWhileItsContentHoldsStill() {
        let message = ChatMessage.optimistic(role: .assistant, text: "Half a rep", id: "stream-1")
        let row = { (message: ChatMessage, prompt: String?, streaming: Bool) in
            MessageBubble(
                message: message,
                userPrompt: prompt,
                isStreaming: streaming,
                openApprovals: {},
                runForReal: nil,
                retry: nil,
                decideApproval: nil
            )
        }

        XCTAssertEqual(row(message, "Book it", true), row(message, "Book it", true))

        // A token landed: the row must rebuild.
        var grown = message
        grown.parts[0].text = "Half a reply, then the rest"
        XCTAssertNotEqual(row(message, "Book it", true), row(grown, "Book it", true))

        // The turn settled, and the prompt above it changed.
        XCTAssertNotEqual(row(message, "Book it", true), row(message, "Book it", false))
        XCTAssertNotEqual(row(message, "Book it", true), row(message, "Cancel it", true))
    }

    func testRowNoticesAnActionBeingSwitchedOff() {
        let message = ChatMessage.optimistic(role: .assistant, text: "That went wrong", id: "a1")
        let row = { (retry: ((String) -> Void)?, hide: (() -> Void)?) in
            MessageBubble(
                message: message,
                userPrompt: "Book it",
                isStreaming: false,
                openApprovals: {},
                runForReal: nil,
                retry: retry,
                decideApproval: nil,
                hide: hide
            )
        }

        XCTAssertEqual(row({ _ in }, {}), row({ _ in }, {}))
        // Retry goes nil while another turn is in flight, hide until the server
        // has stored the row. Both change what the card offers.
        XCTAssertNotEqual(row({ _ in }, {}), row(nil, {}))
        XCTAssertNotEqual(row({ _ in }, {}), row({ _ in }, nil))
    }

    func testReceiptGroupComparesOnItsReceipts() {
        let receipt = { (id: String) in
            ChatMessage(id: id, role: .assistant, parts: [
                .init(type: "text", text: "Sent the invite."),
                .init(type: "approval", status: "approved"),
            ])
        }
        XCTAssertEqual(
            ApprovedReceiptGroup(messages: [receipt("r1"), receipt("r2")]),
            ApprovedReceiptGroup(messages: [receipt("r1"), receipt("r2")])
        )
        XCTAssertNotEqual(
            ApprovedReceiptGroup(messages: [receipt("r1")]),
            ApprovedReceiptGroup(messages: [receipt("r1"), receipt("r2")])
        )
    }

    func testRowNoticesCardRefreshAvailabilityAndFreshnessChanges() {
        let message = ChatMessage(id: "m", role: .assistant, parts: [RichMessageFixture.generated(stale: true)])
        let row = MessageBubble(message: message, userPrompt: nil,
            isStreaming: false, openApprovals: {}, runForReal: nil, retry: nil, decideApproval: nil)
        var available = row
        available.refreshCard = { _, _ in nil }
        XCTAssertNotEqual(row, available)
        let fresh = MessageBubble(message: ChatMessage(id: "m", role: .assistant, parts: [
            RichMessageFixture.generated(updatedAt: "2026-09-19T18:01:00.000Z")
        ]), userPrompt: nil, isStreaming: false,
            openApprovals: {}, runForReal: nil, retry: nil, decideApproval: nil)
        XCTAssertNotEqual(row, fresh)
    }
}
