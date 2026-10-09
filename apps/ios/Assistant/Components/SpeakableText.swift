import Foundation

/// What a reply *sounds* like, as opposed to what it looks like.
///
/// The transcript is not prose. A reply can be a table, a fenced code block, a
/// card that stands in for the answer entirely (`MessageResponseCard.replacesProse`),
/// or three bubbles split by a `[break]` cue. Handing `ChatMessage.text` to a
/// synthesizer therefore fails in both directions at once: silence on a
/// card-answered turn, and Markdown punctuation read aloud on an ordinary one —
/// asterisks, pipes, and a fenced block spelled out character by character.
///
/// So the ear gets its own projection. It reuses the block tree the renderer
/// already parses (`AssistantMarkdown.blocks(in:)`) and walks it with different
/// intentions: prose is spoken, structure is described, and anything that only
/// means something to the eye is named once and skipped.
///
/// Every function here is pure. That is deliberate: this is the part worth
/// testing, and none of it should need an audio session to run.
enum SpeakableText {

    // MARK: - Messages

    /// Everything this message has to say, in the order it should be said.
    ///
    /// Used by explicit playback and by automatic speech after the durable
    /// response arrives, so approval and card privacy are known first.
    static func passages(for message: ChatMessage) -> [String] {
        guard message.role == .assistant else { return [] }

        // A decision is announced, never read out. The payload of an approval
        // is the one thing on screen that must be looked at rather than heard,
        // and speech must not become a way to learn what one says without
        // opening it.
        if message.approvalSummary != nil || !message.decisionParts.isEmpty {
            return ["A decision is waiting for you."]
        }

        var spoken = message.visibleTextBubbles.flatMap { passages(forProse: $0) }
        // No prose means the cards carry the answer.
        if spoken.isEmpty {
            spoken = message.parts
                .compactMap(MessageResponseCard.init(part:))
                .compactMap(passage(for:))
        }

        // A suggestion is not a decision in that sense: it proposes, it holds
        // nothing back, and its prose ("One more thing from your watch:") is
        // only half a sentence without it. So an open one is read after the
        // rest. Speech still answers nothing — the card has to be tapped.
        let questions = message.suggestionParts
            .filter { $0.suggestionStatus.isOpen }
            .compactMap(\.summary)
            .flatMap { passages(forProse: $0) }
        return spoken + questions
    }

    // MARK: - Prose

    /// One Markdown fragment as a list of utterance-sized passages — one per
    /// block, so the synthesizer pauses where the writing does.
    static func passages(forProse source: String) -> [String] {
        AssistantMarkdown.blocks(in: source)
            .flatMap(speech(forBlock:))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private static func speech(forBlock block: AssistantMarkdown.Block) -> [String] {
        switch block {
        case let .heading(_, text):
            return [spoken(text)]
        case let .paragraph(text):
            return [spoken(text)]
        case let .quote(text):
            return [spoken(text)]
        case let .list(nodes):
            return nodes.flatMap(speech(forNode:))
        case let .code(language, _):
            // Reading code aloud is never what anyone wanted. Say it is there.
            let tag: String = language?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let named: String = tag.isEmpty ? "" : "\(spokenLanguageName(tag)) "
            return ["There's a \(named)code block here."]
        case .equation:
            return ["There's an equation here."]
        case .divider:
            return []
        case let .table(headers, rows):
            return [tableSummary(headers: headers, rowCount: rows.count)]
        }
    }

    private static func speech(forNode node: AssistantMarkdown.ListNode) -> [String] {
        let body = spoken(node.text)
        let head: String
        switch node.marker {
        case .bullet:
            head = body
        case let .number(value):
            head = "\(value). \(body)"
        case let .task(isComplete):
            head = isComplete ? "Done: \(body)" : "To do: \(body)"
        }
        return [head] + node.children.flatMap(speech(forNode:))
    }

    /// A table is described, not recited. Its pipes are punctuation for the
    /// eye, and its cells are a grid the ear has no way to hold.
    private static func tableSummary(headers: [String], rowCount: Int) -> String {
        let columns = headers
            .map { spoken($0) }
            .filter { !$0.isEmpty }
        let rows = rowCount == 1 ? "1 row" : "\(rowCount) rows"
        guard !columns.isEmpty else { return "There's a table here, with \(rows)." }
        return "There's a table here, with \(rows): \(list(columns))."
    }

    // MARK: - Cards

    /// A card that stands in for the reply has to say the reply's worth aloud.
    static func passage(for card: MessageResponseCard) -> String? {
        let sentence: String
        switch card {
        case let .generated(generated):
            sentence = generatedCardSpeech(generated)
        case let .briefing(briefing):
            sentence = spoken(briefing.lead)
        case let .route(route):
            sentence = join(["\(RouteCardView.duration(route.durationSeconds)) to \(spoken(route.destination.label))",
                             RouteCardView.distance(route.distanceMeters)])
        case let .scoreboard(_, _, games, _, _, _):
            sentence = join(games.prefix(2).map { game in
                let scores = game.state == "pre" ? "" : " \(game.away.score ?? "") to \(game.home.score ?? "")"
                return "\(spoken(game.away.shortName)) at \(spoken(game.home.shortName))\(scores), \(spoken(game.statusText))"
            })
        case let .agenda(title, subtitle, items):
            let lines = items.map { "\(spoken($0.time)): \(spoken($0.title))" }
            sentence = join([spoken(title), spoken(subtitle)] + lines)
        case let .event(_, _, time, title, location, _, _, _, _):
            sentence = join([spoken(title), spoken(time), spoken(location)])
        case let .weather(location, temperature, condition, _, _, _):
            let place = location.isEmpty ? "" : "In \(spoken(location))"
            sentence = join([place, spoken(temperature), spoken(condition)])
        case let .duration(title, duration, detail, _):
            sentence = join([spoken(title), spoken(duration), spoken(detail ?? "")])
        case let .reminder(_, title, schedule, _, _):
            sentence = join([spoken(title), spoken(schedule)])
        case let .proactiveAlert(_, _, _, title, summary, _, _, _):
            sentence = join([spoken(title), spoken(summary)])
        case let .status(_, title, detail, _, _, _, _):
            sentence = join([spoken(title), spoken(detail)])
        case let .resource(_, _, title, subtitle, _, _, _):
            sentence = join([spoken(title), spoken(subtitle)])
        case let .emails(_, title, _, _, _, _, messages):
            sentence = join([spoken(title), count(messages.count, "email", "emails")])
        case let .documents(_, title, _, passages):
            sentence = join([spoken(title), count(passages.count, "passage", "passages")])
        case let .drive(_, title, _, files):
            sentence = join([spoken(title), count(files.count, "file", "files")])
        case let .search(_, title, _, results):
            sentence = join([spoken(title), count(results.count, "result", "results")])
        case let .thread(_, subject, messageCount, _):
            sentence = join([spoken(subject), count(messageCount, "message", "messages")])
        case let .sheetRows(_, sheetName, _, totalRows, _):
            sentence = join([spoken(sheetName), count(totalRows, "row", "rows")])
        case let .availability(_, _, _, busy, calendarsChecked, complete, _):
            if !busy.isEmpty {
                let booked = count(busy.count, "booked block", "booked blocks")
                sentence = complete
                    ? booked
                    : "\(booked). Availability is incomplete; unlisted time is unknown."
            } else if complete {
                sentence = "Nothing is booked."
            } else if calendarsChecked.isEmpty {
                sentence = "Availability is unconfirmed."
            } else {
                sentence = "No conflicts were found in the checked calendars. Availability is incomplete; unlisted time is unknown."
            }
        case let .knowledgeGraph(_, title, edges, _):
            sentence = join([spoken(title), count(edges.count, "connection", "connections")])
        case let .calendarConflicts(_, title, conflicts, _):
            sentence = join([spoken(title), count(conflicts.count, "conflict", "conflicts")])
        }
        let trimmed = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func generatedCardSpeech(_ card: MessageResponseCard.GeneratedCard) -> String {
        // The runtime composed an accessibility label for this card already —
        // one sentence, written for someone who cannot see it. That is exactly
        // this audience. When the composer sent none, the parser falls back to
        // the title, which is a heading rather than an answer; read the facts
        // in that case instead.
        let label = withoutSensitiveValues(card.accessibilityLabel, in: card)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !label.isEmpty, label != card.title { return spoken(label) }

        // A sensitive fact is held back on screen until it is asked for.
        // Speaking it aloud would undo that, in a room the owner may not be
        // alone in.
        let facts = card.facts
            .filter { !$0.sensitive }
            .map { fact in
                let name = spoken(withoutSensitiveValues(fact.label, in: card))
                let value = spoken(withoutSensitiveValues(fact.value, in: card))
                return name.isEmpty ? value : "\(name): \(value)"
            }
        return join([spoken(withoutSensitiveValues(card.title, in: card)),
                     spoken(withoutSensitiveValues(card.subtitle, in: card))] + facts)
    }

    private static func withoutSensitiveValues(_ text: String, in card: MessageResponseCard.GeneratedCard) -> String {
        card.facts.filter(\.sensitive).map(\.value)
            .filter { $0.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 }
            .sorted { $0.count > $1.count }
            .reduce(text) { result, secret in
                result.replacingOccurrences(of: secret, with: "", options: [.caseInsensitive])
            }
    }

    static func safeAccessibilityLabel(for card: MessageResponseCard.GeneratedCard) -> String {
        let label = withoutSensitiveValues(card.accessibilityLabel, in: card)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return label.isEmpty ? card.title : label
    }

    // MARK: - Words

    /// One Markdown fragment as the words alone: no emphasis characters, no
    /// link targets, no degree signs the synthesizer would swallow.
    static func spoken(_ source: String) -> String {
        guard !source.isEmpty else { return "" }
        var text = String(AssistantMarkdown.inlineAttributed(source).characters)
        text = text.replacingOccurrences(
            of: bareURLPattern,
            with: "a link",
            options: [.regularExpression, .caseInsensitive]
        )
        for (symbol, words) in degreeReplacements {
            text = text.replacingOccurrences(of: symbol, with: words)
        }
        return text
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A URL read character by character is a wall of noise, and the label of a
    /// Markdown link has already replaced the useful ones by this point.
    private static let bareURLPattern = #"\bhttps?://[^\s)]+"#

    /// The synthesizer reads a bare degree sign as nothing at all, which turns
    /// "18°C" into "eighteen C".
    private static let degreeReplacements: [(String, String)] = [
        ("°C", " degrees Celsius"),
        ("ºC", " degrees Celsius"),
        ("°F", " degrees Fahrenheit"),
        ("ºF", " degrees Fahrenheit"),
        ("°", " degrees"),
    ]

    private static func spokenLanguageName(_ language: String) -> String {
        switch language.lowercased() {
        case "js", "javascript": "JavaScript"
        case "ts", "typescript": "TypeScript"
        case "py", "python": "Python"
        case "sh", "bash", "zsh", "shell": "shell"
        case "swift": "Swift"
        case "json": "JSON"
        case "sql": "SQL"
        case "html": "HTML"
        case "css": "CSS"
        default: language
        }
    }

    private static func count(_ value: Int, _ singular: String, _ plural: String) -> String {
        "\(value) \(value == 1 ? singular : plural)"
    }

    private static func list(_ items: [String]) -> String {
        guard items.count > 1 else { return items.first ?? "" }
        return items.dropLast().joined(separator: ", ") + " and " + (items.last ?? "")
    }

    /// Card fields are fragments, not sentences. Join them with full stops so
    /// the synthesizer gives each one its own falling intonation.
    private static func join(_ parts: [String]) -> String {
        parts
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .map { $0.hasSuffix(".") || $0.hasSuffix("?") || $0.hasSuffix("!") ? $0 : "\($0)." }
            .joined(separator: " ")
    }
}

/// How much of one reply has already been said out loud.
///
/// A turn does not arrive as one string. It streams in as deltas against an
/// optimistic `stream-` row, and then that row is thrown away and replaced by
/// the durable one the server persisted (`AppModel.merge`). A turn can also be
/// resumed after the app was backgrounded mid-reply. So spoken progress cannot
/// be a set of message ids — it has to be an offset into the reply itself,
/// carried across the swap. Get that wrong and the owner hears the last two
/// sentences of every reply twice, which is worse than not speaking at all.
struct SpeechProgress {
    /// Characters of the reply already handed to the synthesizer.
    private(set) var consumed = 0
    /// Whether anything has been said for this turn at all. A card-only reply
    /// has no prose to stream, and needs the card spoken once the turn settles.
    private(set) var hasSpoken = false

    /// The next passages to speak, given everything of the reply that has
    /// arrived so far.
    ///
    /// While the reply is still streaming only *finished* blocks are taken: the
    /// text up to the last blank line outside a code fence. A half-written
    /// table would otherwise be described by its first row and then described
    /// again when the rest of it lands.
    mutating func take(from raw: String, isFinal: Bool) -> [String] {
        // The durable twin is not always byte-identical to what streamed — a
        // split point leaves whitespace residue. Never let a shorter text mean
        // "say it again".
        let length = raw.count
        if length < consumed { consumed = length }

        let limit = isFinal ? length : SpeechProgress.finishedPrefixLength(of: raw)
        guard limit > consumed else { return [] }

        let start = raw.index(raw.startIndex, offsetBy: consumed)
        let end = raw.index(raw.startIndex, offsetBy: limit)
        consumed = limit

        let passages = SpeakableText.passages(forProse: String(raw[start..<end]))
        if !passages.isEmpty { hasSpoken = true }
        return passages
    }

    /// Everything this turn will speak has now been spoken.
    mutating func finish(at length: Int) {
        consumed = max(consumed, length)
    }

    /// How much of a partial reply is safe to read: up to the last blank line
    /// that is not inside an open code fence. A blank line closes every
    /// Markdown block except a fence, so the text before one can no longer
    /// change meaning when more arrives.
    static func finishedPrefixLength(of raw: String) -> Int {
        var offset = 0
        var safe = 0
        var insideFence = false

        for line in raw.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                insideFence.toggle()
            } else if trimmed.isEmpty && !insideFence {
                safe = offset
            }
            offset += line.count + 1
        }
        return safe
    }
}
