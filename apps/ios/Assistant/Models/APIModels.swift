import Foundation

struct SituationSource: Codable, Hashable {
    var kind: String
    var id: String
}
struct SituationSnapshot: Codable, Hashable {
    var revision: String
    var state: String
    var title: String
    var details: String
}
struct SituationItem: Codable, Identifiable, Hashable {
    var id: String = UUID().uuidString
    var title: String = ""
    var details: String = ""
    var lane: String = "plan"
    var dependsOn: [String] = []
    var source: SituationSource? = nil
    var snapshot: SituationSnapshot? = nil
    var needsReview: Bool = false
}
struct SituationDecision: Codable, Identifiable {
    var id: String = UUID().uuidString
    var option: String = ""
    var outcome: String = "chosen"
    var reason: String = ""
    var scope: String = "situation"
    var confirmed: Bool = true
}
struct SituationData: Codable {
    var items: [SituationItem]
    var decisions: [SituationDecision]
}
struct SituationChange: Decodable {
    var itemId: String
    var before: SituationSnapshot?
    var after: SituationSnapshot?
}
struct SituationPack: Decodable, Identifiable {
    var id: String
    var title: String
    var version: Int
    var archived: Bool
    var updatedAt: String
    var data: SituationData
    var changes: [SituationChange]
    var affectedIds: [String]
}
struct SituationSourceOption: Decodable, Identifiable {
    var id: String
    var kind: String
    var title: String
    var lane: String
    var key: String { "\(kind):\(id)" }
}
struct SituationOverview: Decodable {
    var packs: [SituationPack]
    var sources: [SituationSourceOption]
}
struct SituationPreview: Decodable, Identifiable {
    var id: String
    var packId: String
    var baseVersion: Int
    var before: SituationItem
    var after: SituationItem
    var affectedIds: [String]
    var unknowns: [String]
    var expiresAt: String
}
struct SituationCommand: Encodable {
    var action: String
    var packId: String? = nil
    var version: Int? = nil
    var title: String? = nil
    var creationKey: String? = nil
    var item: SituationItem? = nil
    var decision: SituationDecision? = nil
    var itemId: String? = nil
    var previewId: String? = nil
}
struct SituationCommandResult: Decodable {
    var ok: Bool
    var packId: String?
    var error: String?
    var preview: SituationPreview?
}

enum JSONValue: Codable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try container.decode([JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .bool(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var string: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    /// Converts only finite, exactly representable integral values. Numeric
    /// JSON is untrusted card content; `Int(Double)` traps outside the range.
    var integerValue: Int? {
        guard case let .number(value) = self, value.isFinite,
              value.rounded(.towardZero) == value,
              value >= Double(Int.min), value < Double(Int.max) else { return nil }
        return Int(value)
    }
}

enum ChatRole: String, Codable, Sendable {
    case user
    case assistant
}

struct MessagePart: Codable, Hashable, Sendable {
    let type: String
    var text: String?
    var data: JSONValue?
    var notice: String?
    var rememberLabel: String? = nil
    var approvalId: String?
    var taskId: String?
    var suggestionId: String?
    var shortCode: String?
    var summary: String?
    var purpose: String?
    var approvalCount: Int?
    var approvalIds: [String]? = nil
    var pendingCount: Int? = nil
    var outcomes: [ApprovalSummaryOutcome]? = nil
    var status: String?
    var originalText: String?
    var reason: String?
    var repairId: String?
    var presentation: ChatCardPresentation?
    var proposedBudgetUsd: Double?
    /// Auto-recall provenance. Optional keeps an older server and all prior
    /// message parts decodable while GraphRAG rolls out.
    var sources: [MessageRecallSource]? = nil
    /// The work a suggestion would hand the assistant if accepted. The card
    /// asks with `summary`; this is what the resulting task is told to do.
    var proposedAction: String? = nil
    /// The task an accepted suggestion became, hydrated by the server.
    var acceptedTaskId: String? = nil
    var acceptedTaskStatus: String? = nil
    var acceptedTaskSummary: String? = nil
    /// Authoritative wake time, supplied when a snoozed suggestion is hydrated.
    /// Keep the wire value optional so older servers remain decodable.
    var snoozedUntil: String? = nil
    /// Explicit server pairing only; older clients keep rendering the sibling card.
    var contextCard: JSONValue? = nil
    var actionLabel: String? = nil

    /// Where a suggestion part stands. The server hydrates `status` on every
    /// read, so a part it has not hydrated yet is a live question; a status
    /// this build does not know reads as gone rather than as open.
    var suggestionStatus: SuggestionStatus {
        status.map { SuggestionStatus(rawValue: $0) ?? .missing } ?? .pending
    }

    /// Apply only an acknowledged decision for an approval this part names.
    /// Repeated delivery is idempotent; a partial decision never settles the
    /// other approvals sharing the same summary.
    mutating func applyApprovalDecision(id: String, status: String) {
        if type == "approval", approvalId == id { self.status = status }
        guard type == "approval-summary",
              approvalIds?.contains(id) == true || outcomes?.contains(where: { $0.id == id }) == true
        else { return }
        var current = outcomes ?? []
        let previous = current.first(where: { $0.id == id })
        let wasPending = previous == nil || previous?.status == "pending" || previous?.status == "snoozed"
        if let index = current.firstIndex(where: { $0.id == id }) {
            current[index].status = status
        } else {
            current.append(.init(id: id, summary: purpose ?? "", status: status))
        }
        outcomes = current
        if wasPending, let pendingCount { self.pendingCount = max(0, pendingCount - 1) }
    }
}

/// "I noticed X — want me to Y?" Deliberately not an approval: an approval
/// holds work that is about to happen, a suggestion proposes work nobody has
/// started. Accepting creates a task under the normal action permissions — so a
/// suggestion never counts toward the approval inbox, badge or Island.
enum SuggestionStatus: String, Sendable {
    case pending
    case accepted
    case dismissed
    case snoozed
    case expired
    case missing

    /// Only a live question asks. A hydrated `snoozed` is a snooze still
    /// sleeping — an elapsed one comes back from the server as `pending` — so
    /// until then it settles like any other answer rather than re-asking.
    var isOpen: Bool { self == .pending }
}

/// The three answers a suggestion card offers. "Later" is a snooze.
enum SuggestionDecision: String, Codable, Sendable {
    case accepted
    case dismissed
    case snoozed
}

/// An answer given on this device, held over later reads of the log until
/// the server says the same thing itself.
struct SuggestionAnswer: Hashable, Sendable {
    let decision: SuggestionDecision
    var taskId: String? = nil
    var snoozedUntil: Date? = nil
}

/// Accepted means work exists; completion comes from that task's actual state.
enum SuggestionTaskReceipt {
    static func title(for status: String?) -> String {
        switch status {
        case "done", "completed": "Completed"
        case "failed", "dead", "dead_letter": "Couldn’t complete"
        case "cancelled": "Cancelled"
        case "pending", "queued": "Queued"
        case "sleeping", "waiting_event": "Waiting"
        case "running": "Working on it"
        case let value? where value.hasPrefix("waiting_") || value == "needs_attention": "Needs attention"
        default: "Accepted"
        }
    }

    static func detail(for status: String?) -> String {
        switch status {
        case "done", "completed": "The task finished. View its status in Activity."
        case "failed", "dead", "dead_letter": "The task did not finish. View the details in Activity."
        case "cancelled": "The task was cancelled. View the details in Activity."
        case "pending", "queued": "The task is waiting to start."
        case "sleeping", "waiting_event": "The task is waiting to continue."
        case "running": "The assistant is working on this task."
        case let value? where value.hasPrefix("waiting_") || value == "needs_attention":
            "The task needs attention. View the next step in Activity."
        default: "The assistant accepted this as a task. View its status in Activity."
        }
    }
}

/// Plain state and scheduling copy, shared by the visible receipt and VoiceOver.
/// A device clock cannot authorize reopening a suggestion: hydration owns that.
struct SuggestionReceiptPresentation {
    let title: String
    let detail: String
    let symbol: String
    let returnDate: Date?
    let isSnoozed: Bool

    init(part: MessagePart) {
        isSnoozed = part.suggestionStatus == .snoozed
        returnDate = isSnoozed ? part.snoozedUntil.flatMap {
            ISO8601DateFormatter.assistant.date(from: $0)
                ?? AssistantFormatters.internetDateTime.date(from: $0)
        } : nil
        switch part.suggestionStatus {
        case .accepted:
            title = SuggestionTaskReceipt.title(for: part.acceptedTaskStatus)
            detail = SuggestionTaskReceipt.detail(for: part.acceptedTaskStatus)
            symbol = part.acceptedTaskStatus == "done" || part.acceptedTaskStatus == "completed" ? "checkmark.circle.fill" : "tray.full.fill"
        case .dismissed:
            title = "Dismissed"
            detail = "You passed on this suggestion."
            symbol = "xmark.circle.fill"
        case .snoozed:
            title = "Snoozed"
            detail = returnDate == nil ? "A return time wasn’t provided." : "The suggestion reopens when the snooze ends."
            symbol = "clock.fill"
        case .expired:
            title = "Expired"
            detail = "This suggestion is no longer waiting for an answer."
            symbol = "clock.badge.exclamationmark.fill"
        case .pending:
            title = "Suggested next step"
            detail = "Accept to create a task, choose Later, or dismiss this suggestion."
            symbol = "lightbulb.fill"
        case .missing:
            title = "No longer available"
            detail = "This suggestion is no longer available."
            symbol = "minus.circle.fill"
        }
    }

    /// An absolute local date stays unambiguous across midnight, travel, and
    /// delayed reads. Date.FormatStyle reuses its formatter infrastructure.
    func returnLabel(locale: Locale = .autoupdatingCurrent, timeZone: TimeZone = .autoupdatingCurrent) -> String? {
        guard isSnoozed else { return nil }
        guard let returnDate else { return "Return time unavailable" }
        let style = Date.FormatStyle(date: .abbreviated, time: .shortened, locale: locale, timeZone: timeZone)
        return "Returns \(returnDate.formatted(style))"
    }
}

struct ApprovalSummaryOutcome: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let summary: String
    var status: String
}

/// Permission and execution are different receipts. A granted permission never
/// claims the requested work succeeded, and an unknown status cannot invite a
/// second decision against an unreadable request.
struct DecisionReceiptPresentation: Equatable, Sendable {
    enum Tone: Equatable, Sendable { case success, error, muted }
    let title: String
    let detail: String
    let symbol: String
    let tone: Tone
    let reviewInActivity: Bool
    let reviewInApprovals: Bool

    init(part: MessagePart) {
        reviewInActivity = ["failed", "expired"].contains(part.status ?? "")
        reviewInApprovals = !["approved", "denied", "rejected", "expired", "failed", "cancelled", "resolved", "closed"].contains(part.status ?? "")
        switch part.status {
        case "approved":
            title = part.type == "budget-request" ? "Budget approved" : "Approved"
            detail = part.type == "budget-request"
                ? "The budget change was approved. Check Activity for the task’s outcome."
                : "Permission was granted for this request. Check Activity for the outcome."
            symbol = "checkmark.circle.fill"
            tone = .success
        case "denied", "rejected":
            title = "Declined"
            detail = "Permission was declined for this request."
            symbol = "xmark.circle.fill"
            tone = .error
        case "expired":
            title = "Expired"
            detail = "This decision expired. Review Activity if the task still needs attention."
            symbol = "clock.badge.exclamationmark.fill"
            tone = .muted
        case "failed":
            title = "Request failed"
            detail = "Review Activity to understand the failure before retrying."
            symbol = "exclamationmark.circle.fill"
            tone = .error
        case "cancelled":
            title = "Cancelled"
            detail = "This decision was cancelled."
            symbol = "minus.circle.fill"
            tone = .muted
        case "resolved", "closed":
            title = "Closed"
            detail = "This decision is no longer waiting for a response."
            symbol = "minus.circle.fill"
            tone = .muted
        default:
            title = "Status unavailable"
            detail = "Refresh Approvals to check the current decision."
            symbol = "questionmark.circle"
            tone = .muted
        }
    }
}

/// A finished row must remain readable even when a provider supplies no prose
/// or a newer server sends a card this client cannot render. Never infer that a
/// tool-only response means an action completed, or automatically repeat it.
struct AssistantOutputFallback: Equatable, Sendable {
    let title: String
    let detail: String
}

struct ChatCardFact: Codable, Hashable, Sendable {
    let label: String
    let value: String
}

struct ChatCardPresentation: Codable, Hashable, Sendable {
    let version: Int
    let headline: String
    let summary: String
    let facts: [ChatCardFact]?
    let detailLabel: String?
    let diagnostics: [String]?
}

struct MessageRecallSource: Codable, Hashable, Identifiable, Sendable {
    let date: String
    let label: String
    let kind: String?
    let hops: Int?
    /// Opaque owner-scoped source identity and exact content revision. Older
    /// replies have neither field and remain readable without gaining controls.
    let surfaceKey: String?
    let sourceRevision: String?

    var isKnowledgeGraph: Bool { kind == "knowledge_graph" }

    var id: String { surfaceKey ?? "\(kind ?? "unknown"): \(date): \(label)" }

    var hasCurrentLedgerReference: Bool {
        Self.isDigest(surfaceKey) && Self.isDigest(sourceRevision)
    }

    var displayGroup: String {
        switch kind ?? "" {
        case "chat": "earlier chats"
        case "knowledge_graph": "knowledge graph"
        case "decision", "situation_decision": "saved decisions"
        case "commitment": "commitments"
        default: "saved context"
        }
    }

    private static func isDigest(_ value: String?) -> Bool {
        guard let value, value.count == 64 else { return false }
        return value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}

enum RecallSourceControlOutcome: Equatable {
    case updated
    case stale
    case failed
    case discarded
}

struct RecallSourceMutationResponse: Codable, Sendable {
    let ok: Bool
    let version: Int
}

struct RecallSourceStateResponse: Codable, Sendable {
    let suppressed: Bool
}

struct RecallSourceMutationBody: Encodable, Sendable {
    let suppressed: Bool
    let expectedSourceRevision: String
}

struct ChatMessage: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let role: ChatRole
    var parts: [MessagePart]
    var metadata: [String: JSONValue]?

    func applyingApprovalDecisions(_ decisions: [String: String]) -> Self {
        var message = self
        for index in message.parts.indices {
            for (id, status) in decisions {
                message.parts[index].applyApprovalDecision(id: id, status: status)
            }
        }
        return message
    }

    /// Lay answers given here over a read that may predate them. Only the
    /// suggestions they name change; the rest of the row is the server's.
    func applyingSuggestionAnswers(_ answers: [String: SuggestionAnswer], now: Date = Date(), acknowledging: Bool = false) -> Self {
        guard !answers.isEmpty else { return self }
        var message = self
        for index in message.parts.indices where message.parts[index].type == "suggestion" {
            guard let id = message.parts[index].suggestionId, let answer = answers[id] else { continue }
            let status = message.parts[index].suggestionStatus
            // An acknowledged answer can cover a stale open read. It cannot
            // replace a conflicting terminal decision or resurrect erased work.
            guard [.pending, .snoozed].contains(status) || status.rawValue == answer.decision.rawValue else { continue }
            if answer.decision == .snoozed {
                // A stale poll cannot wake a snooze, but its deadline can. A
                // terminal decision from another device always takes precedence.
                // Only the immediate acknowledgement may settle an unknown-time
                // legacy snooze. Later reads must let the server wake it.
                guard answer.snoozedUntil.map({ $0 > now }) ?? acknowledging,
                      [.pending, .snoozed].contains(status) else { continue }
                // A hydrated snooze supplies the server's current deadline.
                // Only an older open read needs this device's acknowledged one.
                if status == .pending || message.parts[index].snoozedUntil == nil,
                   let until = answer.snoozedUntil {
                    message.parts[index].snoozedUntil = ISO8601DateFormatter.assistant.string(from: until)
                }
            }
            message.parts[index].status = answer.decision.rawValue
            if answer.decision == .accepted, let taskId = answer.taskId,
               status != .accepted || message.parts[index].acceptedTaskId == nil {
                message.parts[index].acceptedTaskId = taskId
            }
        }
        return message
    }

    var text: String {
        parts.compactMap { $0.type == "text" ? $0.text : nil }.joined()
    }

    /// One entry per chat bubble: a reply split by the assistant's [break]
    /// cue persists as several text parts and streams the same way (a
    /// data-break part starts a new text part). Whitespace-only parts are a
    /// split point's residue — they join into `text` but render as nothing.
    var textBubbles: [String] {
        parts
            .filter { $0.type == "text" }
            .compactMap(\.text)
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    var createdAt: Date? {
        guard let raw = metadata?["createdAt"]?.string else { return nil }
        return ISO8601DateFormatter.assistant.date(from: raw)
    }

    /// A row the server has stored, as opposed to the echo of a turn still in
    /// flight. Only these can be hidden from the log: the others have no id
    /// the server would recognise, and they settle into durable rows anyway.
    var isDurableLogRow: Bool {
        !id.hasPrefix("local-") && !id.hasPrefix("stream-")
    }

    var quickReplies: [String] {
        for part in parts.reversed() where part.type == "data-chips" {
            guard case let .object(object) = part.data,
                  case let .array(labels)? = object["labels"] else { continue }
            return labels.compactMap(\.string).prefix(4).map { String($0.prefix(60)) }
        }
        return []
    }

    var face: CompanionFace? {
        for part in parts.reversed() where part.type == "data-face" {
            guard case let .object(object) = part.data,
                  let raw = object["state"]?.string,
                  let face = CompanionFace(rawValue: raw) else { continue }
            return face
        }
        return nil
    }

    var mood: CompanionMood? {
        for part in parts.reversed() where part.type == "data-theme" {
            guard case let .object(object) = part.data,
                  let raw = object["name"]?.string,
                  let mood = CompanionMood(rawValue: raw) else { continue }
            return mood
        }
        return nil
    }

    var recallSources: [MessageRecallSource] {
        parts.first(where: { $0.type == "recall" })?.sources ?? []
    }

    var decisionParts: [MessagePart] {
        parts.filter { ["approval", "budget-request"].contains($0.type) }
    }

    /// Proactive suggestions, kept out of `decisionParts` on purpose. Nothing
    /// waits on one, so none of the approval machinery — pending counts, the
    /// approved-receipt run, the spoken "decision is waiting" — applies. And a
    /// decision card replaces its prose where a suggestion does not: the text
    /// beside it is what explains it ("One more thing from your watch:"). A
    /// part with no id has nothing a card could answer, so it is not drawn.
    var suggestionParts: [MessagePart] {
        parts.filter { $0.type == "suggestion" && !($0.suggestionId ?? "").isEmpty }
    }

    /// Re-read open questions, sleeping snoozes, and accepted work until its
    /// result lands, so a completed task never stays labelled as running.
    var hasUnsettledSuggestion: Bool {
        suggestionParts.contains { part in
            if part.suggestionStatus == .pending || part.suggestionStatus == .snoozed { return true }
            return part.suggestionStatus == .accepted && part.acceptedTaskId != nil
                && !["done", "completed", "failed", "cancelled", "dead", "dead_letter"].contains(part.acceptedTaskStatus ?? "")
        }
    }

    var hasRefreshingCard: Bool {
        parts.contains { part in
            guard part.type == "data-card", case let .object(data)? = part.data else { return false }
            return data["kind"] == .string("generated-card") && data["refreshState"] == .string("refreshing")
        }
    }

    func applyingCardRefreshes(_ markers: [String: CardRefreshMarker]) -> Self {
        guard !markers.isEmpty else { return self }
        var message = self
        for index in message.parts.indices where message.parts[index].type == "data-card" {
            guard case var .object(data)? = message.parts[index].data,
                  data["kind"] == .string("generated-card"),
                  let id = data["id"]?.string, let marker = markers[id],
                  marker.holds(revisionId: data["revisionId"]?.string, updatedAt: data["updatedAt"]?.string,
                               state: data["refreshState"]?.string,
                               refreshTaskId: data["refreshTaskId"]?.string) else { continue }
            data["refreshState"] = .string("refreshing")
            data["refreshError"] = nil
            message.parts[index].data = .object(data)
        }
        return message
    }

    /// Dashboard mirrors carry a compact reason and count rather than the raw
    /// approval payloads. The Approvals screen remains the exact review surface.
    var approvalSummary: ApprovalSummary? {
        for part in parts where part.type == "approval-summary" {
            guard let purpose = part.purpose?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !purpose.isEmpty else { continue }
            let total = max(part.approvalCount ?? 1, part.approvalIds?.count ?? 0, 1)
            let outcomes = part.outcomes ?? []
            let answered = outcomes.filter { $0.status != "pending" && $0.status != "snoozed" }.count
            return ApprovalSummary(purpose: purpose, approvalCount: total,
                pendingCount: max(0, part.pendingCount ?? (total - answered)), outcomes: outcomes)
        }
        return nil
    }

    /// Runtime decision prose and the structured card say the same thing.
    /// Keep one visual object in the transcript: the card, whose live status
    /// can change after the message itself was persisted.
    var visibleTextBubbles: [String] {
        decisionParts.isEmpty && approvalSummary == nil ? textBubbles : []
    }

    func outputFallback(isStreaming: Bool, hasRenderableCards: Bool) -> AssistantOutputFallback? {
        guard role == .assistant, !isStreaming, visibleTextBubbles.isEmpty,
              decisionParts.isEmpty, approvalSummary == nil, suggestionParts.isEmpty,
              !hasRenderableCards, noticeKind == nil, !isOffCourse else { return nil }
        if parts.contains(where: { $0.type == "data-card" }) {
            return .init(title: "Card unavailable in this app",
                detail: "This reply contains a card the app couldn’t display. Review Activity or open your assistant on the web.")
        }
        return .init(title: "No readable reply",
            detail: "The assistant returned no readable answer. Review Activity before asking again, in case an action already ran.")
    }

    /// Runtime notices and proactive cards do not answer the nearest owner
    /// question. A suggestion only ever arrives from a background writer (the
    /// server counts it among its notice parts), so it is one of those too.
    var isConversationAnswer: Bool {
        role == .assistant && !visibleTextBubbles.isEmpty && !parts.contains { part in
            if part.type == "notice" || part.type == "suggestion" { return true }
            guard part.type == "data-card", case let .object(data) = part.data else { return false }
            return data["kind"]?.string == "proactive-alert"
        }
    }

    /// Raw lookup results are evidence for the prose answer. Locally inferred
    /// cards and authored/generated answer cards still own their presentation.
    var hasSupportingResultCards: Bool {
        guard role == .assistant, !visibleTextBubbles.isEmpty, noticeKind == nil else { return false }
        // A briefing card is the answer itself; the conflicts card riding with
        // it must not fold the briefing into "Sources and details".
        let hasBriefing = parts.contains { part in
            guard part.type == "data-card", case let .object(data) = part.data else { return false }
            return data["kind"]?.string == "briefing"
        }
        if hasBriefing { return false }
        let resultKinds: Set<String> = [
            "calendar-event", "email-results", "document-results", "drive-results",
            "web-search-results", "availability", "email-thread", "sheet-rows",
            "knowledge-graph", "calendar-conflicts"
        ]
        return parts.contains { part in
            guard part.type == "data-card", case let .object(data) = part.data,
                  let kind = data["kind"]?.string else { return false }
            return resultKinds.contains(kind)
        }
    }

    var noticeKind: ChatNoticeKind? {
        parts.lazy
            .filter { $0.type == "notice" }
            .compactMap { $0.notice.flatMap(ChatNoticeKind.init(rawValue:)) }
            .first
    }

    var noticePresentation: ChatCardPresentation? {
        parts.first { $0.type == "notice" && $0.presentation?.version == 1 }?.presentation
    }

    var retractedOriginalText: String? {
        parts.first { $0.type == "notice" && $0.notice == "retracted" }?.originalText
    }

    var retractionReason: String? {
        parts.first { $0.type == "notice" && $0.notice == "retracted" }?.reason
    }

    /// The tool-less chat path's honesty guard marked this reply: it claimed
    /// work that never ran. Live the marker is a `data-off-course` stream
    /// part; the persisted message carries a `notice` part with the same
    /// meaning. Kept out of ChatNoticeKind on purpose — an off-course reply
    /// keeps its text and ADDS the card, it is not replaced by one.
    var isOffCourse: Bool {
        parts.contains { part in
            part.type == "data-off-course" || (part.type == "notice" && part.notice == "off-course")
        }
    }

    /// An approval or budget decision still waiting on the owner. A pending
    /// suggestion is not one — see `hasUnsettledSuggestion`.
    var hasPendingDecision: Bool {
        (approvalSummary?.pendingCount ?? 0) > 0 || decisionParts.contains { part in
            part.status == nil || part.status == "pending" || part.status == "snoozed"
        }
    }

    /// A resolved approval normally carries its original explanatory text and
    /// one structured approval part. The text is intentionally hidden by the
    /// receipt UI, so adjacent receipts of this exact shape can share one
    /// transcript card without concealing another response or live decision.
    var isApprovedApprovalReceipt: Bool {
        role == .assistant
            && !decisionParts.isEmpty
            && decisionParts.allSatisfy { $0.type == "approval" && $0.status == "approved" }
            && parts.allSatisfy { ["text", "approval"].contains($0.type) }
    }

    static func optimistic(role: ChatRole, text: String, id: String = "local-\(UUID().uuidString)") -> Self {
        .init(id: id, role: role, parts: [.init(type: "text", text: text)])
    }
}

struct ApprovalSummary: Hashable, Sendable {
    let purpose: String
    let approvalCount: Int
    let pendingCount: Int
    let outcomes: [ApprovalSummaryOutcome]
}

/// Transcript presentation deliberately stays separate from persisted
/// messages: the server still supplies one durable receipt per approval, while
/// the app makes a run of settled receipts easier to scan.
enum ChatTranscriptItem: Identifiable, Hashable {
    case message(ChatMessage, index: Int)
    case approvedReceiptGroup([ChatMessage], firstIndex: Int)

    var id: String {
        switch self {
        case let .message(message, _):
            return message.id
        case let .approvedReceiptGroup(messages, _):
            return "approved-receipts-\(messages.map(\.id).joined(separator: "-"))"
        }
    }

    var firstIndex: Int {
        switch self {
        case let .message(_, index), let .approvedReceiptGroup(_, index):
            return index
        }
    }
}

/// Chronological order for the rendered log, and the only place order is
/// decided. Everything else — a poll's merge, a streamed reply's appends, a
/// refresh folding the durable log back in — only puts messages in the set;
/// this puts them in sequence. (The web client orders its log the same way;
/// see orderChatLog.)
///
/// Persisted rows sort by the send time the server stamped them with and
/// tie-break on id, exactly as the server ordered them (`created_at, id`).
/// A row the client made itself — an optimistic user turn, a reply still
/// streaming — has no send time yet, so it anchors to the newest send time in
/// the log when it first appeared and holds that place until its durable twin
/// arrives. Anchoring to the log rather than to the device clock is what keeps
/// a question above the answer arriving under it on a device whose clock runs
/// fast or slow.
///
/// A place is assigned once per id and never recomputed, so nothing already on
/// screen moves as later messages come in. Without this, a merge could only
/// append: a refresh that brought back the durable twins of four optimistic
/// turns re-homed all four to the bottom of the log, under the replies that
/// had already answered them.
struct ChatLogOrder {
    private struct Position {
        let sentAt: Date
        let arrival: Int
        let persisted: Bool
    }

    private var positions: [String: Position] = [:]

    /// Forget every assigned place. A different conversation's ids have no
    /// order to agree with these.
    mutating func reset() { positions.removeAll() }

    mutating func ordered(_ messages: [ChatMessage]) -> [ChatMessage] {
        // One send-time read per message: parsing it is the expensive part,
        // and this runs on every poll.
        let sendTimes = messages.map { (id: $0.id, sentAt: $0.createdAt) }
        let newest = sendTimes.compactMap(\.sentAt).max() ?? .distantPast
        for message in sendTimes {
            assign(id: message.id, sentAt: message.sentAt, anchoredTo: newest)
        }
        let places = positions
        return messages.sorted { left, right in
            guard let first = places[left.id], let second = places[right.id] else { return false }
            if first.sentAt != second.sentAt { return first.sentAt < second.sentAt }
            // A client-made row anchored to this send time when it appeared,
            // so it belongs after everything the server already stamped with
            // it. Keeping the two kinds apart is also what makes this a total
            // order: id decides between durable rows, arrival between local
            // ones, and the two rules never have to agree with each other.
            if first.persisted != second.persisted { return first.persisted }
            return first.persisted ? left.id < right.id : first.arrival < second.arrival
        }
    }

    private mutating func assign(id: String, sentAt: Date?, anchoredTo anchor: Date) {
        let existing = positions[id]
        if let existing, existing.persisted { return }
        guard let sentAt else {
            guard existing == nil else { return }
            positions[id] = Position(sentAt: anchor, arrival: positions.count, persisted: false)
            return
        }
        // A row that arrives durable, or one that gains its send time on a
        // later read, keeps the place it already holds in the sequence.
        positions[id] = Position(
            sentAt: sentAt,
            arrival: existing?.arrival ?? positions.count,
            persisted: true
        )
    }
}

extension Array where Element == ChatMessage {
    /// Collapse only a consecutive run of two or more fully settled approval
    /// receipts. A user message, pending/declined decision, budget card, or
    /// any other message content always remains a hard visual boundary.
    func transcriptItems() -> [ChatTranscriptItem] {
        var items: [ChatTranscriptItem] = []
        var index = startIndex

        while index < endIndex {
            let message = self[index]
            guard message.isApprovedApprovalReceipt else {
                items.append(.message(message, index: index))
                formIndex(after: &index)
                continue
            }

            let firstIndex = index
            var receipts: [ChatMessage] = []
            while index < endIndex, self[index].isApprovedApprovalReceipt {
                receipts.append(self[index])
                formIndex(after: &index)
            }

            if receipts.count == 1, let receipt = receipts.first {
                items.append(.message(receipt, index: firstIndex))
            } else {
                items.append(.approvedReceiptGroup(receipts, firstIndex: firstIndex))
            }
        }

        return items
    }
}

enum ChatNoticeKind: String, Codable, Sendable {
    case responseContract = "response-contract"
    case parked
    case needsAttention = "needs-attention"
    case turnFailed = "turn-failed"
    case providerFailed = "provider-failed"
    case retracted
}

enum CompanionFace: String, Codable, Sendable {
    case neutral
    case warmSmile = "warm_smile"
    case happySquint = "happy_squint"
    case curiousBlink = "curious_blink"
    case thoughtfulTilt = "thoughtful_tilt"
    case wideExcited = "wide_excited"
    case gentleNod = "gentle_nod"
    case focused
}

enum CompanionMood: String, Codable, Sendable {
    case `default`
    case warmAmber = "warm_amber"
    case softRose = "soft_rose"
    case coolSky = "cool_sky"

    /// How many recent assistant messages a theme cue reaches forward over.
    /// Mirrors THEME_LOOKBACK in packages/core/src/chat-cues.ts.
    static let lookback = 8

    /// The chat's color mood — pinned to `.default`. The owner asked to keep
    /// the mood color unchanged permanently, so this ignores any `[theme:]`
    /// cue in the log (the dashboard persona no longer emits them, but older
    /// messages can still carry one). Mirrors the web client's
    /// `latestTheme(log)` (see apps/web/lib/chat-cues.ts), and lives here
    /// rather than on AppModel so it is reachable from tests.
    static func latest(in _: [ChatMessage]) -> CompanionMood {
        .default
    }
}

enum AssistantPresence: String, Codable, Sendable {
    case idle
    case working
    case attention
}

struct AgentIdentity: Codable, Sendable {
    let id: String
    let name: String
    let avatarUrl: String?
}

struct DashboardStatus: Codable, Sendable {
    let pendingApprovals: Int
    let needsAttention: Int
    let presence: AssistantPresence
}

struct MemoryHealth: Codable, Sendable {
    let totalUsable: Int
    let notYetOrganized: Int
    let awaitingReview: Int
    let ownerConfirmed: Int
    let lastOrganizedAt: String?
}

struct ShellStatus: Codable, Sendable {
    let dashboard: DashboardStatus
    let memoryHealth: MemoryHealth
}

struct ConversationRecord: Codable, Sendable {
    let id: String
    let title: String?
    let modelOverride: String?
    let archivedAt: String?
    let isPrimary: Bool
}

struct ModelOption: Codable, Identifiable, Sendable {
    let id: String
    let label: String
}

struct AsyncTurn: Codable, Sendable {
    let taskId: String
    let cursor: String
}

struct ConversationView: Codable, Sendable {
    let conversation: ConversationRecord
    let agentName: String
    let agentTimezone: String
    let messages: [ChatMessage]
    let models: [ModelOption]
    let goalTitle: String?
    let canArchive: Bool
    let cursor: String?
    let asyncTurn: AsyncTurn?
}

struct BootstrapResponse: Codable, Sendable {
    let generatedAt: String
    let identity: AgentIdentity
    let shell: ShellStatus
    let conversation: ConversationView
}

struct ActivityItem: Codable, Identifiable, Sendable {
    let id: String
    let type: String
    let status: String
    let title: String?
    let progress: String
    let trust: String
    let spentUsd: String
    let budgetUsdLimit: String
    let updatedAt: String
    let archivedAt: String?
    let hasPendingApproval: Bool
    let hasActiveAutonomy: Bool?
    let stuckWaiting: Bool?
    let createdAt: String?
    let conversationId: String?
    let source: String?
    let externalEventId: String?

    init(
        id: String,
        type: String,
        status: String,
        title: String?,
        progress: String,
        trust: String,
        spentUsd: String,
        budgetUsdLimit: String,
        updatedAt: String,
        archivedAt: String?,
        hasPendingApproval: Bool,
        hasActiveAutonomy: Bool? = nil,
        stuckWaiting: Bool? = nil,
        createdAt: String? = nil,
        conversationId: String? = nil,
        source: String? = nil,
        externalEventId: String? = nil
    ) {
        self.id = id
        self.type = type
        self.status = status
        self.title = title
        self.progress = progress
        self.trust = trust
        self.spentUsd = spentUsd
        self.budgetUsdLimit = budgetUsdLimit
        self.updatedAt = updatedAt
        self.archivedAt = archivedAt
        self.hasPendingApproval = hasPendingApproval
        self.hasActiveAutonomy = hasActiveAutonomy
        self.stuckWaiting = stuckWaiting
        self.createdAt = createdAt
        self.conversationId = conversationId
        self.source = source
        self.externalEventId = externalEventId
    }

    var displayTitle: String {
        let candidate = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !candidate.isEmpty else { return type.sentenceCaseIdentifier }
        return candidate.isMachineIdentifier ? candidate.sentenceCaseIdentifier : candidate
    }

    var displayProgress: String {
        let humanized = Self.progressPrefixes.reduce(progress) { result, replacement in
            result.replacingOccurrences(of: replacement.technical, with: replacement.human)
        }
        // Pipeline diagnostics are useful in server logs but are not a user
        // progress message. Hiding them here keeps Activity readable while
        // preserving the raw value in the task record for diagnostics.
        let lower = humanized.lowercased()
        if lower.hasPrefix("pulse:") || lower.hasPrefix("document processor:") ||
            lower.contains("no-candidates") || lower.contains("segmentation") {
            return ""
        }
        return humanized
    }

    var budgetSummary: String {
        "\(Self.displayUSD(spentUsd)) of \(Self.displayUSD(budgetUsdLimit))"
    }

    private static let progressPrefixes: [(technical: String, human: String)] = [
        ("documents.process", "Document processing"),
        ("documents.extract", "Document extraction"),
        ("ambient:", "Background update:"),
        ("dream:", "Reflection:"),
        ("self-improve:", "Improvement review:"),
        ("self-maintain:", "Maintenance:"),
    ]

    private static func displayUSD(_ raw: String) -> String {
        let locale = Locale(identifier: "en_US_POSIX")
        guard let value = Decimal(string: raw, locale: locale) else { return "$\(raw)" }

        let needsFinePrecision = value > 0 && value < 0.01
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = false
        formatter.minimumFractionDigits = needsFinePrecision ? 5 : 2
        formatter.maximumFractionDigits = needsFinePrecision ? 5 : 2
        let rendered = formatter.string(from: NSDecimalNumber(decimal: value)) ?? raw
        return "$\(rendered)"
    }
}

struct ActivityList: Codable, Sendable {
    let items: [ActivityItem]
    let archivedCount: Int
    let nextCursor: String?
    let searchIncomplete: Bool?
    let scanned: Int?
    let captureStatus: String?

    init(items: [ActivityItem], archivedCount: Int, nextCursor: String? = nil,
         searchIncomplete: Bool? = nil, scanned: Int? = nil, captureStatus: String? = nil) {
        self.items = items
        self.archivedCount = archivedCount
        self.nextCursor = nextCursor
        self.searchIncomplete = searchIncomplete
        self.scanned = scanned
        self.captureStatus = captureStatus
    }
}

struct ArchiveOldActivityProgress: Codable, Sendable {
    let operationId: String?
    let scannedThisBatch: Int
    let archivedThisBatch: Int
    let scannedTotal: Int
    let archivedTotal: Int
    let complete: Bool
}

struct GoalRecord: Codable, Identifiable, Sendable {
    let id: String
    let title: String
    let description: String
    let status: String
    let priority: Int
    let progress: String
    let nextAction: String
    let targetDate: String?
    let createdAt: String
    let updatedAt: String
    let archivedAt: String?
    let mirrorToPrimary: Bool
    let autonomy: Bool
    let taintedOrigin: Bool

    /// Human-facing goal title. Test and automation-created goals can arrive
    /// with a timestamp/run id appended to a machine identifier; that suffix
    /// is useful to the server but turns into four lines of noise on a phone.
    var displayTitle: String {
        let candidate = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidate.isEmpty else { return "Untitled goal" }

        let withoutRunIdentifier = candidate.replacingOccurrences(
            of: #"-\d{10,}(?:-\d+(?:\.\d+)?)?$"#,
            with: "",
            options: .regularExpression
        )
        let resolved = withoutRunIdentifier.isEmpty ? candidate : withoutRunIdentifier
        return resolved.isMachineIdentifier ? resolved.sentenceCaseIdentifier : resolved
    }
}

struct GoalAutomation: Codable, Sendable {
    let enabled: Bool
    let nextRunAt: String?
}

struct GoalDashboardItem: Codable, Identifiable, Sendable {
    var id: String { goal.id }
    let goal: GoalRecord
    let conversationId: String?
    let workActive: Bool
    let automation: GoalAutomation?
    let cadenceLabel: String
    let blockedQuestion: String
    let stalled: Bool
}

struct GoalsDashboard: Codable, Sendable {
    let items: [GoalDashboardItem]
    let archivedCount: Int
}

struct ApprovalRecord: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let shortCode: String
    let summary: String
    let payload: JSONValue
    let resolutionPayload: JSONValue?
    let status: String
    let requestedAt: String
    let resolvedAt: String?
    let resolvedVia: String?
    let expiresAt: String
}

struct PendingApproval: Codable, Identifiable, Sendable {
    var id: String { approval.id }
    let approval: ApprovalRecord
    let taskType: String
    let taskTrust: String
    let toolName: String
    let decision: JSONValue
    var rememberLabel: String? = nil
}

/// A settled approval as the history list reads it. The server deliberately
/// trims payloads from resolved rows — the payloads that made the decision
/// worth reviewing stay in the database — so this is NOT the `ApprovalRecord`
/// the pending list decodes. Decoding it as one fails the whole overview the
/// moment a single approval resolves.
struct ResolvedApprovalRecord: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let shortCode: String
    let summary: String
    let status: String
    let requestedAt: String
    let resolvedAt: String?
    let resolvedVia: String?
    let expiresAt: String
    /// Whether the owner changed the arguments before approving. Optional so a
    /// newer app remains decodable against an older server mid-rollout.
    let edited: Bool?
}

struct ResolvedApproval: Codable, Identifiable, Sendable {
    var id: String { approval.id }
    let approval: ResolvedApprovalRecord
    let taskType: String
}

struct ApprovalInbox: Codable, Sendable {
    let pending: [PendingApproval]
    let resolved: [ResolvedApproval]
}

struct DocumentRecord: Codable, Identifiable, Sendable {
    let id: String
    let title: String
    let mime: String
    let source: String
    let trust: String
    let status: String
    let extractor: String
    let chunkCount: Int
    let charCount: Int
    let bytes: Int
    let error: String?
    let createdAt: String
}

struct DocumentStats: Codable, Sendable {
    let total: Int
    let ready: Int
    let pending: Int
    let chunks: Int
}

struct DocumentsOverview: Codable, Sendable {
    var documents: [DocumentRecord]
    let stats: DocumentStats
    let primaryConversationId: String
    var hasMore: Bool? = nil
    var pagination: CursorPagination? = nil
}

struct OverviewResponse: Codable, Sendable {
    let generatedAt: String
    let activity: ActivityList
    let goals: GoalsDashboard
    let approvals: ApprovalInbox
    let documents: DocumentsOverview
}

struct WorkspaceResponse: Codable, Sendable {
    let generatedAt: String
    /// Per-destination read status. Missing metadata means an older server sent
    /// the original all-or-nothing shape; unknown future states fail closed.
    let sectionAvailability: [String: WorkspaceSectionAvailability]?
    var chats: WorkspaceChats
    let memory: WorkspaceMemory
    var skills: [WorkspaceSkill]
    // Optional so a newer app remains usable while an older server is still
    // rolling out the capabilities projection.
    let capabilities: [WorkspaceCapability]?
    let settings: WorkspaceSettings
    let costs: WorkspaceCosts
    var anomalies: [WorkspaceAnomaly]
    var improvements: [WorkspaceImprovement]
    var sectionPagination: WorkspaceSectionPaginationIndex?
    var repairs: WorkspaceRepairs? = nil
    var imports: WorkspaceImports?

    func isSectionAvailable(_ section: String) -> Bool {
        guard let state = sectionAvailability?[section] else { return true }
        return state.isAvailable
    }
}

struct WorkspaceSectionPaginationIndex: Codable, Sendable {
    var chats: WorkspaceChatPagination?
    var skills: WorkspaceSectionPagination?
    var anomalies: WorkspaceSectionPagination?
    var improvements: WorkspaceSectionPagination?
    var importSources: WorkspaceSectionPagination?
    var importFiles: WorkspaceSectionPagination?
}

struct WorkspaceChatPagination: Codable, Sendable {
    var current: WorkspaceSectionPagination
    var archived: WorkspaceSectionPagination
}

struct WorkspaceSectionPagination: Codable, Sendable {
    let endpoint: String
    let pageSize: Int
    var consistency: String?
    var loaded: Int
    var hasMore: Bool
    var complete: Bool
    var nextCursor: String?
    let archived: Bool?
}

enum WorkspacePageSection: String, Codable, Sendable {
    case chats, skills, anomalies, improvements
    case importSources = "import-sources"
    case importFiles = "import-files"
}

struct WorkspaceSectionPage<Item: Codable & Sendable>: Codable, Sendable {
    let section: String
    let items: [Item]
    let pagination: WorkspacePageResponseMetadata
    let availability: WorkspaceSectionAvailability
}

struct WorkspacePageResponseMetadata: Codable, Sendable {
    let version: Int
    let consistency: String
    let pageSize: Int
    let hasMore: Bool
    let complete: Bool
    let nextCursor: String?
}

struct WorkspaceSectionAvailability: Codable, Sendable {
    let status: String
    let version: Int
    let message: String?

    var isAvailable: Bool { status == "available" && version == 1 }
}

struct SavedCardsResponse: Codable, Sendable {
    let cards: [SavedCardRecord]
}

/// A live scoreboard re-read: the same game objects a scoreboard card carries.
struct LiveScoresPayload: Decodable, Sendable {
    let fetchedAt: String?
    let games: [JSONValue]
}

struct CardRefreshResult: Codable, Sendable {
    let ok: Bool
    let taskId: String?
    let refreshState: String?
}

struct CardRefreshMarker: Sendable {
    let revisionId: String?
    let updatedAt: String?
    var taskId: String? = nil

    func holds(revisionId: String?, updatedAt: String?, state: String?, refreshTaskId: String? = nil) -> Bool {
        guard self.revisionId == revisionId && self.updatedAt == updatedAt else { return false }
        if state == "idle", let taskId, taskId == refreshTaskId { return false }
        if state == "failed" { return taskId != nil && refreshTaskId != nil && taskId != refreshTaskId }
        return true
    }
}

struct SavedCardRecord: Codable, Identifiable, Sendable {
    let id: String
    let revisionId: String
    let status: String
    let spec: JSONValue
    let conversationId: String?
    let updatedAt: String
    var stale: Bool? = nil
    var refreshState: String? = nil
    var refreshError: String? = nil
    var refreshTaskId: String? = nil

    var messagePart: MessagePart {
        var data: [String: JSONValue] = [
            "kind": .string("generated-card"),
            "id": .string(id),
            "revisionId": .string(revisionId),
            "spec": spec,
            "updatedAt": .string(updatedAt),
        ]
        if let stale { data["stale"] = .bool(stale) }
        if let refreshState { data["refreshState"] = .string(refreshState) }
        if let refreshError { data["refreshError"] = .string(refreshError) }
        if let refreshTaskId { data["refreshTaskId"] = .string(refreshTaskId) }
        return .init(type: "data-card", data: .object(data))
    }
}

struct WorkspaceImports: Codable, Sendable {
    var sources: [WorkspaceImportSource]
    var unstartedFiles: [WorkspaceImportFile]
    let sourceAvailability: WorkspaceSectionAvailability?
    let filesAvailability: WorkspaceSectionAvailability?
}

struct WorkspaceImportSource: Codable, Identifiable, Sendable {
    var id: String { source }
    let source: String
    let workspacePath: String
    let kind: String
    let status: String
    let itemsTotal: Int?
    let itemsProcessed: Int
    let memoriesSaved: Int
    let quarantinedNow: Int
    let taskId: String?
    let error: String?
    let updatedAt: String
}

struct WorkspaceImportFile: Codable, Identifiable, Sendable {
    var id: String { name }
    let name: String
    let dir: Bool
}

struct WorkspaceCapability: Codable, Identifiable, Sendable {
    let id: String
    let title: String
    let summary: String
    let enabled: Bool
    let ready: Bool
    let status: String?
    let detail: String

    var statusTitle: String {
        switch status {
        case "off": return "Off"
        case "ready": return "Ready"
        case "setup_needed": return "Setup needed"
        case "unavailable": return "Status unavailable"
        default:
            if !enabled { return "Off" }
            return ready ? "Ready" : "Setup needed"
        }
    }

    var icon: String {
        switch id {
        case "browser": "safari"
        case "code": "terminal"
        case "documents": "doc.text.magnifyingglass"
        case "google": "square.grid.2x2"
        case "reminders": "bell.badge"
        case "search": "magnifyingglass"
        case "sms": "message"
        case "watches": "eye"
        default: "puzzlepiece.extension"
        }
    }
}

struct WorkspaceChats: Codable, Sendable {
    var current: [WorkspaceChat]
    var archived: [WorkspaceChat]
}

struct WorkspaceChat: Codable, Identifiable, Sendable {
    let id: String
    let title: String?
    let isPrimary: Bool
    let updatedAt: String
    let active: Bool

    var displayTitle: String {
        let candidate = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return candidate.isEmpty || candidate == "Untitled" ? "New conversation" : candidate
    }
}

struct WorkspaceMemory: Codable, Sendable {
    let ownerName: String?
    /// The owner contact is the subject for facts created from the iPhone.
    /// Optional keeps an app paired to an older server usable until it refreshes.
    let ownerContactId: String?
    let health: MemoryHealth
    let facts: [WorkspaceMemoryFact]
    let awaitingReview: [WorkspaceMemoryFact]
    let peopleCount: Int
    let people: [WorkspacePerson]?
    let card: WorkspaceMemoryCard?
    let voiceStats: WorkspaceVoiceStats?
    let latestOrganizer: WorkspaceMemoryOrganizer?
}

struct WorkspacePerson: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let aliases: [String]
    let relationship: String
    let trust: String
    let factCount: Int
}

struct PersonProfileResponse: Codable, Sendable {
    let contact: PersonProfileContact
    let occasions: [PersonOccasion]
    let mergeOptions: [PersonMergeOption]
    /// Dates already sitting in this person's saved facts that are not yet
    /// recurring occasions. The endpoint has always sent these; leaving them
    /// off this struct meant Codable dropped them and the phone could not
    /// offer the one-tap save the web page does.
    /// Optional, not a defaulted array: synthesized Codable throws on a missing
    /// key rather than falling back to a default, so a server that ever omits
    /// this would fail the whole profile fetch. Same reason MessagePart keeps
    /// its newer fields optional.
    var occasionSuggestions: [PersonOccasionSuggestion]?
    /// Present only when another contact looks like the same person. Web shows
    /// this as a "possible duplicate" hint beside the merge control.
    var duplicate: PersonDuplicateHint?
}

struct PersonOccasionSuggestion: Codable, Sendable, Identifiable, Hashable {
    let kind: String
    let month: Int
    let day: Int
    var id: String { "\(kind)-\(month)-\(day)" }
}

struct PersonDuplicateHint: Codable, Sendable {
    let targetId: String
    let reason: String
}

// Identifiable because MemoryView presents the person editor with
// .sheet(item:), which requires it — an `id` field alone does not satisfy it.
struct PersonProfileContact: Codable, Sendable, Identifiable {
    let id: String
    let name: String
    let aliases: [String]
    let relationship: String
    let trust: String
}

struct PersonOccasion: Codable, Identifiable, Sendable {
    let id: String
    let kind: String
    let label: String
    let month: Int
    let day: Int
    let year: Int?
    let notes: String
    let quarantined: Bool
    var leadDays: Int? = nil
}

struct PersonMergeOption: Codable, Identifiable, Sendable {
    let id: String
    let label: String
}

// MARK: - People

/// One row of the People directory.
///
/// Every label arrives already rendered by `/api/mobile/v1/people`. The rules
/// behind them — when a birth year may become an age, when a start date may
/// become a duration — live in the application layer, so this client formats
/// nothing and cannot drift from the web.
struct PersonSummary: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let initials: String
    let relationship: String
    let group: String
    /// Empty for the "other" bucket, which is a placement rather than a label.
    let groupLabel: String
    let trust: String
    let location: String?
    let factCount: Int
    /// "18 March · turns 40 in 7 months", or nil when none is recorded.
    let birthday: String?
    /// Days until the next birthday, for the "Coming up" section.
    let birthdayDaysUntil: Int?
    /// "Last contact today", or nil when nothing has been recorded.
    let lastContact: String?
}

struct PersonDirectoryResponse: Codable, Sendable {
    let generatedAt: String
    let people: [PersonSummary]
    var pagination: CursorPagination? = nil
}

struct CursorPagination: Codable, Sendable {
    let version: Int
    let consistency: String
    let pageSize: Int
    let hasMore: Bool
    let complete: Bool
    let nextCursor: String?

    var isSupported: Bool {
        version == 1 && consistency == "live-keyset" && (1...100).contains(pageSize)
            && hasMore == (nextCursor != nil) && complete == !hasMore
    }
}

/// One person↔person connection. `sentence` is composed server-side because
/// the grammar is not mechanical: symmetric predicates read "A and B are
/// partners", directed ones "A is B's parent".
struct PersonRelationSummary: Codable, Identifiable, Sendable {
    let id: String
    let sentence: String
    let otherLabel: String
    let otherInitials: String
    /// Set when the other end is a contact this app can open.
    let otherContactId: String?
    /// "10 years" / "Since 2019" / empty when the source states no span.
    let span: String
    let unreviewed: Bool
}

/// A connection to a place, employer, or event rather than to a person.
struct PersonConnectionSummary: Codable, Identifiable, Sendable {
    let id: String
    let sentence: String
    let span: String
}

/// Something that happened, dated to the day.
struct PersonEventSummary: Codable, Identifiable, Sendable {
    let id: String
    let content: String
    /// "Today" / "2 August" / "14 November 2025".
    let date: String
    /// True when the date is the assistant's write time, not a stated one.
    let dateIsRecordTime: Bool
}

struct PersonReminder: Codable, Sendable {
    let headline: String
    let detail: String
}

/// The full person card.
struct PersonCard: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let initials: String
    let relationship: String
    let group: String
    let groupLabel: String
    let trust: String
    let location: String?
    let birthday: String?
    let lastContact: String?
    let howWeMet: [String]
    let relations: [PersonRelationSummary]
    let connections: [PersonConnectionSummary]
    let events: [PersonEventSummary]
    let eventsAreRecent: Bool
    let reminder: PersonReminder?
    let factCount: Int
}

struct WorkspaceMemoryCard: Codable, Sendable {
    let content: String
    let compiledAt: String
}

struct WorkspaceVoiceStats: Codable, Sendable {
    let total: Int
    let auto: Int
    let uploaded: Int
}

/// The distilled writing voice: what the assistant imitates when it drafts.
/// `dos` and `donts` are lines on the wire and lines in the editor; the server
/// splits and trims them, so nothing here needs to.
struct VoiceProfile: Codable, Sendable {
    var description: String
    var dos: [String]
    var donts: [String]
    var signature: String

    static let empty = Self(description: "", dos: [], donts: [], signature: "")
}

struct VoiceProfileResponse: Codable, Sendable {
    let voiceStats: WorkspaceVoiceStats
    let voiceProfile: VoiceProfile
}

/// One row of the memory library, already worded by the server.
struct MemoryLibraryRow: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let content: String
    let domain: String
    let ownerConfirmed: Bool
    let pinned: Bool
    let importance: Int
    let organized: Bool
    let originTrust: String
    let subjectLabel: String
    /// Whether this memory is the owner's own. The label cannot stand in for
    /// it: an owner fact joins the owner's contact and so carries their name.
    /// Optional so an older server stays decodable; defaulted at the use site.
    var aboutOwner: Bool?
    let connectionCount: Int
    let projectionStatus: String
    let createdAt: String
}

struct MemoryLibrarySubject: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let label: String
    let trust: String
}

struct MemoryLibraryResponse: Codable, Sendable {
    let rows: [MemoryLibraryRow]
    let total: Int
    let page: Int
    let totalPages: Int
    let subjects: [MemoryLibrarySubject]
    let sources: [String]

    static let empty = Self(rows: [], total: 0, page: 1, totalPages: 1, subjects: [], sources: [])
}

/// What the library is being asked for. Mirrors the web query string exactly so
/// the two clients page and filter the same way.
struct MemoryLibraryQuery: Equatable, Sendable {
    var state = "in-use"
    var filter = "all"
    var search = ""
    var domain = ""
    var subjectId = ""
    var source = ""
    /// "" for any age, otherwise the window in days the web library offers.
    var ageDays = ""
    var connectivity = "all"
    var page = 1

    var items: [URLQueryItem] {
        var items = [
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "filter", value: filter),
            URLQueryItem(name: "connectivity", value: connectivity),
            URLQueryItem(name: "page", value: String(page)),
        ]
        if !search.isEmpty { items.append(.init(name: "q", value: search)) }
        if !domain.isEmpty { items.append(.init(name: "domain", value: domain)) }
        if !subjectId.isEmpty { items.append(.init(name: "subjectId", value: subjectId)) }
        if !source.isEmpty { items.append(.init(name: "source", value: source)) }
        if !ageDays.isEmpty { items.append(.init(name: "ageDays", value: ageDays)) }
        return items
    }
}

/// An open loop the assistant is tracking — a promise made, a question left
/// hanging. The memory desk has always shown these on the web.
struct Commitment: Codable, Sendable, Identifiable {
    let id: String
    let kind: String
    let title: String
    let details: String
    let nextAction: String
    /// ISO-8601, or nil when the loop has no deadline.
    let dueAt: String?
    let status: String
}

struct CommitmentsResponse: Codable, Sendable {
    let commitments: [Commitment]
}

struct CommitmentMutation: Encodable, Sendable {
    let action: String
    let id: String
    var title: String? = nil
    var details: String? = nil
    var nextAction: String? = nil
}

struct VoiceProfileMutation: Encodable, Sendable {
    var action = "voice-profile"
    let description: String
    let dos: String
    let donts: String
    let signature: String
}

struct WorkspaceMemoryOrganizer: Codable, Sendable {
    let id: String
    let status: String
    let progress: String
    let updatedAt: String
}

struct WorkspaceMemoryFact: Codable, Identifiable, Sendable {
    let id: String
    let content: String
    let kind: String
    let domain: String?
    let ownerConfirmed: Bool
    let pinned: Bool
    let importance: Int
    let createdAt: String
}

// MARK: - Knowledge graph

struct KnowledgeEntity: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let label: String
    let kind: String
    let canonicalKey: String

    var displayLabel: String {
        label.replacingOccurrences(of: "_", with: " ")
    }
}

struct KnowledgeSearchResponse: Codable, Sendable {
    let entities: [KnowledgeEntity]
}

struct KnowledgePresentation: Codable, Hashable, Sendable {
    let sentence: String
    let label: String
    let accessibleLabel: String
}

struct KnowledgeAssertionEndpointView: Codable, Hashable, Sendable {
    let assertionId: String
    let semanticRevision: Int
    let focusEntityId: String
    let relatedEntityId: String
    let direction: String
    let subjectEntityId: String
    let predicate: String
    let objectEntityId: String
    let text: String
    let accessibilityText: String
    let evidenceCount: Int
    let reviewStatus: String
}

struct KnowledgeSource: Codable, Hashable, Sendable {
    let memoryId: String
    let content: String
    let createdAt: String
    let ownerConfirmed: Bool
    let originTrust: String
}

struct KnowledgeRelation: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let subject: KnowledgeEntity
    let predicate: String
    let object: KnowledgeEntity
    let confidence: Double
    let reviewStatus: String
    let validFrom: String?
    let validUntil: String?
    /// Optional for a short rolling-deploy window with an older server.
    let inRecall: Bool?
    let source: KnowledgeSource
    let presentation: KnowledgePresentation
    /// Optional during rolling deploys. The selected endpoint gets conservative inverse wording.
    var endpointViews: [KnowledgeAssertionEndpointView]? = nil

    func accessibilityText(focusedAt entityID: String) -> String {
        endpointViews?.first(where: { $0.focusEntityId == entityID })?.accessibilityText
            ?? presentation.accessibleLabel
    }

    func displayText(focusedAt entityID: String) -> String {
        endpointViews?.first(where: { $0.focusEntityId == entityID })?.text
            ?? presentation.sentence
    }

    var needsReview: Bool { reviewStatus == "unreviewed" }

    /// Traversal changes the focus, never the stored direction of the fact.
    func connectedEntity(to entityID: String) -> KnowledgeEntity? {
        if subject.id == entityID && object.id != entityID { return object }
        if object.id == entityID && subject.id != entityID { return subject }
        return nil
    }
}

struct KnowledgeOverview: Codable, Sendable {
    let totalEntities: Int
    let totalRelations: Int
    let unreviewedRelations: Int
    let entities: [KnowledgeEntity]
    let matchingEntities: Int
    let entityPage: Int
    let entityPages: Int
    let selected: KnowledgeEntity?
    let relations: [KnowledgeRelation]
    let selectedActiveRelationTotal: Int
    let duplicates: [KnowledgeDuplicate]

    /// The API may include an alphabetically first item for legacy clients.
    /// Only an explicit, matching selection should be presented as a detail.
    func entitySelected(by selectedID: String?) -> KnowledgeEntity? {
        guard let selectedID, selected?.id == selectedID else { return nil }
        return selected
    }
}

/// UI projection only: source-level review and correction remain independent.
struct KnowledgeConnection: Identifiable {
    let id: String
    let relation: KnowledgeRelation
    var sources: [KnowledgeRelation]
    var confirmed: Bool { sources.contains { $0.reviewStatus == "confirmed" } }

    static func group(_ relations: [KnowledgeRelation]) -> [KnowledgeConnection] {
        var groups: [KnowledgeConnection] = []
        for relation in relations where relation.reviewStatus != "rejected" {
            let parts = [relation.subject.id, relation.predicate, relation.object.id,
                         relation.validFrom ?? "", relation.validUntil ?? ""]
            let key = parts.map { "\($0.utf8.count):\($0)" }.joined()
            if let index = groups.firstIndex(where: { $0.id == key }) {
                groups[index].sources.append(relation)
            } else {
                groups.append(.init(id: key, relation: relation, sources: [relation]))
            }
        }
        return groups
    }
}

struct KnowledgeDuplicate: Codable, Identifiable, Hashable, Sendable {
    let targetId: String
    let label: String
    let kind: String
    let reason: String
    var id: String { targetId }
}

struct KnowledgeReviewInbox: Codable, Sendable {
    let relations: [KnowledgeRelation]
}

struct KnowledgeCleanupFinding: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let kind: String
    let title: String
    let detail: String
    let memoryId: String?
    let relationId: String?
    let count: Int
}

struct KnowledgeCleanupResponse: Codable, Sendable {
    let findings: [KnowledgeCleanupFinding]
}

struct KnowledgeSourceImpact: Codable, Sendable {
    struct Item: Codable, Identifiable, Sendable {
        let id: String
        let label: String
    }
    let memoryId: String
    let content: String
    /// Legacy total retained while older servers roll out the active/retired split.
    let connectionCount: Int
    let activeConnectionCount: Int?
    let retiredProjectionCount: Int?
    let orphanedItems: [Item]

    var activeConnections: Int { activeConnectionCount ?? connectionCount }
    var retiredProjections: Int { retiredProjectionCount ?? 0 }
}

struct KnowledgeConnectionMutation: Codable, Sendable {
    let subjectLabel: String
    let subjectKind: String
    let subjectId: String?
    let predicate: String
    let objectLabel: String
    let objectKind: String
    let objectId: String?
    let note: String
}

struct KnowledgeCorrectionMutation: Codable, Sendable {
    let action: String
    let subjectLabel: String
    let subjectKind: String
    let subjectId: String?
    let predicate: String
    let objectLabel: String
    let objectKind: String
    let objectId: String?
    let note: String
}

struct WorkspaceSkill: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let preconditions: String
    let steps: String
    let gotchas: String
    let ownerAuthored: Bool
    let deprecated: Bool
    let useCount: Int
    let successCount: Int
    let failureCount: Int
    let updatedAt: String
}

struct WorkspaceSettings: Codable, Sendable {
    let agent: WorkspaceAgentSettings
    let schedules: [WorkspaceSchedule]
    let reminders: [WorkspaceReminder]
    let policies: [WorkspacePolicy]
    let goalAutomationCount: Int

    private enum CodingKeys: String, CodingKey {
        case agent, schedules, reminders, policies, goalAutomationCount
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        agent = try container.decode(WorkspaceAgentSettings.self, forKey: .agent)
        schedules = try container.decode([WorkspaceSchedule].self, forKey: .schedules)
        reminders = try container.decodeIfPresent([WorkspaceReminder].self, forKey: .reminders) ?? []
        policies = try container.decode([WorkspacePolicy].self, forKey: .policies)
        goalAutomationCount = try container.decode(Int.self, forKey: .goalAutomationCount)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(agent, forKey: .agent)
        try container.encode(schedules, forKey: .schedules)
        try container.encode(reminders, forKey: .reminders)
        try container.encode(policies, forKey: .policies)
        try container.encode(goalAutomationCount, forKey: .goalAutomationCount)
    }
}

struct WorkspaceAgentSettings: Codable, Sendable {
    let name: String
    let timezone: String
    let locale: String
    let signature: String
}

struct WorkspaceSchedule: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    /// Human wording from the server's own label dictionary; nil for names it
    /// doesn't know, in which case the UI sentence-cases the identifier.
    let label: String?
    let cron: String
    let enabled: Bool
    let nextRunAt: String?
    let lastRunAt: String?

    var displayName: String { label ?? name.sentenceCaseIdentifier }
}

struct WorkspaceReminder: Codable, Identifiable, Sendable {
    let id: String
    let text: String
    let kind: String
    let status: String
    let nextRunAt: String?

    var repeats: Bool { kind == "recurring" }
    var isDelivering: Bool { status == "delivering" }
}

struct WorkspacePolicy: Codable, Identifiable, Sendable {
    let id: String
    let toolName: String
    let templateKey: String
    /// Human wording from the server's own label dictionary; nil for keys it
    /// doesn't know, in which case the UI sentence-cases the identifier.
    let label: String?
    let effect: String
    let enabled: Bool
    let createdVia: String

    var scope: String? = nil

    var displayName: String { label ?? templateKey.sentenceCaseIdentifier }
}

struct WorkspaceCosts: Codable, Sendable {
    var billing: [WorkspaceProviderBilling]? = nil
    var byEvidence: [WorkspaceCostEvidence]? = nil
    let dailySpentUsd: Double
    let monthlySpentUsd: Double
    let heldUsd: Double
    let dailyLimitUsd: Double?
    let monthlyLimitUsd: Double?
    let taskDefaultLimit: String?
    let parkedTasks: Int
    let bySource: [WorkspaceCostBreakdown]
    let byModel: [WorkspaceModelBreakdown]
    let held: [WorkspaceHeldCost]
    let topTasks: [WorkspaceCostTask]
    let recent: [WorkspaceCostEvent]
}

struct WorkspaceCostEvidence: Codable, Identifiable, Sendable {
    var id: String { basis }
    let basis: String
    let usd: String
    let count: Int

    var label: String {
        switch basis {
        case "provider_reported": "Provider-reported"
        case "token_rate": "Estimated from usage and rates"
        case "preflight_estimate": "Estimated without complete usage"
        default: "Unverified / historical"
        }
    }
}

struct WorkspaceProviderBilling: Codable, Identifiable, Sendable {
    let id: String
    let label: String
    let status: String
    let period: String
    let scope: String
    let source: String
    let message: String
    let fetchedAt: String?
    let latestExportAt: String?
    let latestUsageAt: String?
    let lines: [WorkspaceBillingLine]
    var includedIn: String? = nil
    var forecast: WorkspaceBillingForecast? = nil
}

struct WorkspaceBillingForecast: Codable, Sendable {
    let through: String
    let observedDays: Double
    let daysInMonth: Double
    let totals: [WorkspaceBillingForecastTotal]
    let message: String
}

struct WorkspaceBillingForecastTotal: Codable, Sendable {
    let currency: String
    let spent: Double
    let dailyAverage: Double
    let projected: Double
}

struct WorkspaceBillingLine: Codable, Sendable {
    let service: String
    let detail: String
    let currency: String
    let cost: Double
    let credits: Double
    let net: Double
}

struct WorkspaceCostBreakdown: Codable, Identifiable, Sendable {
    var id: String { source }
    let source: String
    let usd: String?
    let count: Int

    private enum CodingKeys: String, CodingKey {
        case source
        case usd
        case count
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        source = try container.decode(String.self, forKey: .source)
        usd = try container.decodeIfPresent(String.self, forKey: .usd)
        count = try container.decodeIntegerOrPostgresCount(forKey: .count)
    }
}

struct WorkspaceModelBreakdown: Codable, Identifiable, Sendable {
    var id: String { model }
    let model: String
    let usd: String?
    let count: Int

    private enum CodingKeys: String, CodingKey {
        case model
        case usd
        case count
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        model = try container.decode(String.self, forKey: .model)
        usd = try container.decodeIfPresent(String.self, forKey: .usd)
        count = try container.decodeIntegerOrPostgresCount(forKey: .count)
    }
}

struct WorkspaceHeldCost: Codable, Identifiable, Sendable {
    let id: String
    let source: String
    let description: String
    let estimatedUsd: String
}

struct WorkspaceCostTask: Codable, Identifiable, Sendable {
    var id: String { taskId ?? "\(type)-\(progress)" }
    let taskId: String?
    let usd: String?
    let type: String
    let progress: String
}

struct WorkspaceCostEvent: Codable, Identifiable, Sendable {
    let id: String
    let createdAt: String
    let source: String
    let description: String
    let usd: String
}

struct WorkspaceAnomaly: Codable, Identifiable, Sendable {
    let id: String
    let kind: String
    let toolName: String
    let detail: String
    let observed: Int
    let expected: Int
    let citationCount: Int
    let hasPolicy: Bool
    let createdAt: String
}

struct WorkspaceImprovement: Codable, Identifiable, Sendable {
    let id: String
    let kind: String
    let title: String
    let rationale: String
    let suggestion: String
    let evidenceCount: Int
    let applyable: Bool
    let createdAt: String
}

enum WorkspaceImprovementAction: String, Equatable, Sendable {
    case apply, dismiss
    case requestFix = "request_fix"
}

struct ImprovementDecisionResult: Codable, Sendable {
    let ok: Bool
    var outcome: String? = nil
    var enacted: Bool? = nil
    var detail: String? = nil
    var repairIssueId: String? = nil
    var repairStatus: String? = nil

    var receiptTitle: String {
        guard ok else { return "Decision not confirmed" }
        if let repairIssueId, !repairIssueId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            switch repairStatus {
            case "reported": return "Code-fix report queued"
            case "failed", "blocked": return "Code-fix report needs attention"
            case "resolved": return "Code-fix report confirmed fixed"
            default: return "Code-fix report linked"
            }
        }
        switch outcome {
        case "applied" where enacted == true: return "Change applied"
        case "acknowledged" where enacted != true: return "Marked reviewed"
        case "dismissed" where enacted != true: return "Dismissed"
        case "already_current" where enacted != true: return "Already using this configuration"
        case "already_decided" where enacted != true: return "Already decided"
        default: return "Decision recorded"
        }
    }

    var receiptDetail: String {
        if let detail, !detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return detail }
        if let repairIssueId, !repairIssueId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Follow the investigation under Code fixes."
        }
        return "Refresh to see the current proposal queue."
    }
}

/// The primary choice and optional acknowledgment are distinct. The exact
/// request_fix wire value prevents a second unsupported code-fix route.
struct ImprovementActionPresentation: Equatable, Sendable {
    let primaryAction: WorkspaceImprovementAction
    let primaryTitle: String
    let primarySymbol: String
    let offersAcknowledgment: Bool

    init(applyable: Bool, canRequestCodeFix: Bool) {
        if applyable {
            primaryAction = .apply
            primaryTitle = "Apply routing change"
            primarySymbol = "checkmark.circle.fill"
            offersAcknowledgment = false
        } else if canRequestCodeFix {
            primaryAction = .requestFix
            primaryTitle = "Request code fix"
            primarySymbol = "hammer"
            offersAcknowledgment = true
        } else {
            primaryAction = .apply
            primaryTitle = "Mark reviewed"
            primarySymbol = "checkmark"
            offersAcknowledgment = false
        }
    }
}

struct McpConnectionsResponse: Codable, Sendable {
    let connections: [McpConnection]
}

struct McpConnection: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let endpoint: String
    let status: String
    let enabled: Bool
    let hasBearerToken: Bool
    let serverName: String?
    let serverVersion: String?
    let instructions: String?
    let tools: [McpConnectionTool]
    let lastCheckedAt: String?
    let lastError: String?

    var displayServerName: String { serverName?.isEmpty == false ? serverName! : name }

    var statusLabel: String {
        switch status {
        case "ready": "Ready"
        case "checking": "Checking"
        case "authorization_required": "Authorization needed"
        case "disabled": "Paused"
        default: "Needs attention"
        }
    }

    var statusIcon: String {
        switch status {
        case "ready": "checkmark.seal.fill"
        case "checking": "arrow.triangle.2.circlepath"
        case "authorization_required": "lock.trianglebadge.exclamationmark"
        case "disabled": "pause.circle.fill"
        default: "exclamationmark.triangle.fill"
        }
    }
}

/// Settings → AI providers. Keys never travel to the phone; `hasApiKey` only
/// says one is saved on the server.
struct ModelProviderSettings: Codable, Sendable {
    let connections: [ModelConnection]
    let models: [CatalogModel]
    let mainModel: String?
    let fastModel: String?
    let voiceModel: String?
    let voicePresets: [VoiceModelPreset]?

    /// Chat models the assistant could route to right now, by connection.
    var choosableGroups: [(connection: ModelConnection, models: [CatalogModel])] {
        groups { $0.routable && !$0.embedding && $0.realtime != true }
    }

    /// Live voice models phone calls could use right now, by connection.
    var voiceGroups: [(connection: ModelConnection, models: [CatalogModel])] {
        groups { $0.routable && $0.realtime == true }
    }

    private func groups(
        _ include: (CatalogModel) -> Bool
    ) -> [(connection: ModelConnection, models: [CatalogModel])] {
        connections.filter(\.enabled).compactMap { connection in
            let models = self.models.filter { $0.connectionId == connection.id && include($0) }
            return models.isEmpty ? nil : (connection, models)
        }
    }
}

struct ModelConnection: Codable, Identifiable, Sendable, Hashable {
    let id: String
    let kind: String
    let label: String
    let baseUrl: String?
    let vertexProject: String?
    let vertexLocation: String?
    let hasApiKey: Bool
    let enabled: Bool
    let source: String
    let lastTestedAt: String?
    let lastError: String?

    var kindLabel: String { ModelConnection.kindLabel(kind) }

    static let kinds = ["openai", "openrouter", "vertex", "openai_compatible"]

    static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "openrouter": "OpenRouter"
        case "openai": "OpenAI"
        case "vertex": "Google Vertex AI"
        default: "OpenAI-compatible"
        }
    }
}

struct CatalogModel: Codable, Identifiable, Sendable, Hashable {
    let id: String
    let label: String
    let connectionId: String
    let enabled: Bool
    let routable: Bool
    let embedding: Bool
    let realtime: Bool?
    let promptCostPerMTok: String?
    let completionCostPerMTok: String?
    let audioInputPerMTok: Double?
    let audioOutputPerMTok: Double?

    var priceLabel: String {
        if realtime == true, let audioIn = audioInputPerMTok, let audioOut = audioOutputPerMTok {
            return String(format: "audio $%.2f / $%.2f per M tokens", audioIn, audioOut)
        }
        let input = Double(promptCostPerMTok ?? "") ?? 0
        let output = Double(completionCostPerMTok ?? "") ?? 0
        return String(format: "$%.2f / $%.2f per M tokens", input, output)
    }
}

struct VoiceModelPreset: Codable, Identifiable, Sendable, Hashable {
    var id: String { "\(connectionId):\(model)" }
    let connectionId: String
    let model: String
    let label: String
    let note: String
}

/// A phone call the assistant placed. Tokens never reach the phone.
struct PhoneCall: Codable, Identifiable, Sendable {
    let id: String
    let to: String
    let contactName: String?
    let status: String
    let active: Bool
    let outcome: String?
    let summary: String?
    let brief: PhoneCallBrief
    let maxMinutes: Int
    let createdAt: String
    let durationSeconds: Int?
    let costUsd: String?
    let transcript: [PhoneCallLine]
    let notes: [String]
    let checkins: [PhoneCallCheckin]
    let openCheckin: PhoneCallCheckin?

    var title: String { contactName ?? to }

    var statusLabel: String {
        switch status {
        case "dialing": "Dialing"
        case "ringing": "Ringing"
        case "in_progress": "On the call"
        case "no_answer": "No answer"
        case "busy": "Busy"
        case "failed": "Failed"
        case "canceled": "Canceled"
        default: "Ended"
        }
    }
}

struct PhoneCallBrief: Codable, Sendable {
    let goal: String
    let context: String
    let mayAgreeTo: String
    let mustNot: String
}

struct PhoneCallLine: Codable, Sendable, Hashable {
    let role: String
    let text: String
    let at: String
}

struct PhoneCallCheckin: Codable, Identifiable, Sendable, Hashable {
    let id: String
    /// Server-issued revision that binds an answer to the delivered question version.
    /// Older payloads may omit it; the client must not guess a revision.
    let revision: Int?
    let question: String
    let answer: String?
}

struct PhoneCallsResponse: Codable, Sendable { let calls: [PhoneCall] }
struct PhoneCallResponse: Codable, Sendable { let call: PhoneCall }

struct ProviderModelListing: Codable, Identifiable, Sendable, Hashable {
    var id: String { model }
    let model: String
    let label: String
    let promptCostPerMTok: String?
    let completionCostPerMTok: String?
    let thinking: Bool?
}

struct ProviderConnectResult: Codable, Sendable {
    let id: String
    let models: [ProviderModelListing]?
    let testError: String?
}

struct ProviderTestResult: Codable, Sendable {
    let models: [ProviderModelListing]
}

struct ModelConnectionInput: Encodable, Sendable {
    var kind: String
    var id: String?
    var label: String?
    var apiKey: String?
    var baseUrl: String?
    var vertexProject: String?
    var vertexLocation: String?
}

struct McpConnectionTool: Codable, Identifiable, Sendable {
    var id: String { name }
    let name: String
    let description: String
    let inputSchema: JSONValue
}

private extension KeyedDecodingContainer {
    /// PostgreSQL drivers often serialize aggregate `count(*)` columns as
    /// strings, while the mobile API's current contract sends an integer. The
    /// app accepts both so an updated client remains compatible with a server
    /// that has not yet deployed the contract normalization.
    func decodeIntegerOrPostgresCount(forKey key: Key) throws -> Int {
        if let integer = try? decode(Int.self, forKey: key) {
            return integer
        }

        let string = try decode(String.self, forKey: key)
        guard let integer = Int(string) else {
            throw DecodingError.typeMismatch(
                Int.self,
                .init(
                    codingPath: codingPath + [key],
                    debugDescription: "Expected an integer or a PostgreSQL count string."
                )
            )
        }
        return integer
    }
}

struct ChatUpdates: Codable, Sendable {
    let taskStatus: String?
    let messages: [ChatMessage]
    let refreshed: [ChatMessage]
    /// Ids of rows an earlier poll delivered that a row in this payload
    /// replaces (a crash-retry re-emitting a task state, a prose mirror
    /// superseded by its structured card). Optional so a stale server build
    /// cannot break decoding of every update.
    let superseded: [String]?
    let nextCursor: String?
    let hasMore: Bool
    let activity: [ToolActivity]
}

struct ToolActivity: Codable, Sendable {
    let toolName: String
    let status: String
    let step: Int

    var thought: AssistantThought {
        let tone: AssistantActivityTone = switch status {
        case "failed", "denied": .failed
        case "awaiting_approval": .waiting
        case "succeeded": .done
        default: .working
        }
        return .init(label: displayLabel, tone: tone)
    }

    /// The same step, described as progress rather than as an outcome.
    ///
    /// `thought` reports a single tool's own tone, which is right for a
    /// per-step readout but wrong for the activity surfaces: `.done`,
    /// `.failed`, and `.waiting` are terminal states owned by the turn. Letting
    /// one finished tool call publish `.done` made the crown claim the whole
    /// turn was over — green checkmark, "Your result is ready", and a success
    /// haptic — after every successful step of a turn still in flight.
    var inProgressThought: AssistantThought {
        .init(label: displayLabel, tone: .working)
    }

    var displayLabel: String {
        Self.labels[toolName] ?? toolName
            .replacingOccurrences(of: ".", with: " ")
            .sentenceCaseIdentifier
    }

    private static let labels: [String: String] = [
        "web.fetch": "Reading a web page",
        "web.search": "Searching the web",
        "weather.lookup": "Checking the weather",
        "sports.scores": "Checking the scores",
        "memory.recall": "Recalling memory",
        "memory.save": "Saving a note to memory",
        "contacts.lookup": "Looking up a contact",
        "conversations.search": "Searching past chats",
        "goals.update_progress": "Updating goal progress",
        "mission.update": "Updating ongoing work",
        "task.schedule": "Scheduling follow-up work",
        "owner.notify": "Leaving you a note",
        "code.execute": "Running code",
        "documents.search": "Searching documents",
        "browser.plan": "Planning a browser task",
        "browser.execute": "Running a browser task",
        "gmail.send": "Sending an email",
        "gmail.create_draft": "Drafting an email",
        "gmail.search": "Searching email",
        "gmail.modify": "Tidying email",
        "calendar.create_event": "Creating a calendar event",
        "calendar.update_event": "Updating a calendar event",
        "calendar.search_events": "Checking the calendar",
        "calendar.list_events": "Checking the calendar",
        "docs.create": "Creating a document",
        "docs.append": "Updating a document",
        "docs.get": "Reading a document",
        "docs.share": "Sharing a document",
        "sheets.create": "Creating a spreadsheet",
        "sheets.append_rows": "Updating a spreadsheet",
        "sheets.write_rows": "Updating a spreadsheet",
        "sheets.get_rows": "Reading a spreadsheet",
        "slides.create": "Creating a presentation",
        "slides.append": "Updating a presentation",
        "drive.search": "Searching Drive",
        "drive.read": "Reading a Drive file",
        "drive.ingest": "Filing a Drive document",
        "sms.send": "Sending a text",
    ]
}

/// Past tense for one call in an answer card's step trail.
///
/// `ToolActivity.labels` names a call that is happening — right for the crown
/// and the live activity, wrong for a trail of work that is over. Kept beside
/// that map so a new tool gets both tenses in one edit, and deliberately the
/// same vocabulary as the web client's `stepActionLabel`
/// (apps/web/lib/views.tsx): one step must not read two ways on two surfaces.
enum ToolStepLabel {
    static func past(for toolName: String) -> String {
        if let known = labels[toolName] { return known }
        // A tool with no phrase of its own is named for what it touched, never
        // shown as the dotted identifier the runtime called.
        let source = toolName.split(separator: ".").first.map(String.init) ?? toolName
        return "Checked \(source.replacingOccurrences(of: "_", with: " "))"
    }

    private static let labels: [String: String] = [
        "web.fetch": "Read a web page",
        "web.search": "Searched the web",
        "weather.lookup": "Checked the weather",
        "sports.scores": "Checked the scores",
        "memory.recall": "Recalled memory",
        "memory.save": "Saved a note to memory",
        "contacts.lookup": "Looked up a contact",
        "conversations.search": "Searched past chats",
        "goals.update_progress": "Updated goal progress",
        "mission.update": "Updated ongoing work",
        "task.schedule": "Scheduled follow-up work",
        "owner.notify": "Left you a note",
        "code.execute": "Ran code",
        "documents.search": "Searched documents",
        "browser.plan": "Planned a browser task",
        "browser.execute": "Ran a browser task",
        "gmail.send": "Sent an email",
        "gmail.create_draft": "Drafted an email",
        "gmail.search": "Searched email",
        "gmail.modify": "Tidied email",
        "calendar.create_event": "Created a calendar event",
        "calendar.update_event": "Updated a calendar event",
        "calendar.search_events": "Checked the calendar",
        "calendar.list_events": "Checked the calendar",
        "docs.create": "Created a document",
        "docs.append": "Updated a document",
        "docs.get": "Read a document",
        "docs.share": "Shared a document",
        "sheets.create": "Created a spreadsheet",
        "sheets.append_rows": "Updated a spreadsheet",
        "sheets.write_rows": "Updated a spreadsheet",
        "sheets.get_rows": "Read a spreadsheet",
        "slides.create": "Created a presentation",
        "slides.append": "Updated a presentation",
        "drive.search": "Searched Drive",
        "drive.read": "Read a Drive file",
        "drive.ingest": "Filed a Drive document",
        "sms.send": "Sent a text message",
    ]
}

struct ApprovalResult: Codable, Sendable {
    let ok: Bool
    let taskId: String
    let toolCallId: String
    let approvalId: String
}

/// `taskId` names the work an accepted suggestion became; the other answers
/// create nothing and leave it out.
struct SuggestionResult: Codable, Sendable {
    let ok: Bool
    let taskId: String?
    var snoozedUntil: String? = nil
}

struct SendReceipt: Sendable {
    let taskId: String?
    let cursor: String?
    let conversationId: String
}

enum ChatOperationCancellationOutcome: String, Decodable, Sendable {
    case cancelledBeforeAdmission = "cancelled_before_admission"
    case cancelled
    case alreadyCancelled = "already_cancelled"
    case alreadyTerminal = "already_terminal"
    case unknown
}

struct ChatOperationCancellationReceipt: Decodable, Sendable {
    let ok: Bool
    let outcome: ChatOperationCancellationOutcome
    let conversationId: String
    let clientOperationId: String
    let taskId: String?
    let taskStatus: String?
    let transitioned: Bool?
    let effectStatus: String?
    let code: String?
}

/// Formatters shared across the app, built once.
///
/// Constructing a `DateFormatter` is expensive — it resolves a locale, a
/// calendar and a format — and these are read while drawing rows, so a new one
/// per call showed up as scroll and streaming cost rather than as a slow screen.
///
/// The locale-sensitive ones take `Locale.autoupdatingCurrent`, but a formatter
/// resolves its format once, so a region changed while the app is running may
/// not reach a shared instance the way a fresh one would. iOS relaunches an app
/// when the region changes, which is what makes that an acceptable trade for
/// not rebuilding a formatter per row. Anything keyed to a fixed wire format
/// pins `en_US_POSIX` instead, and must not be given the device's locale.
enum AssistantFormatters {
    /// Whole-second internet timestamps. `ISO8601DateFormatter.assistant`
    /// expects fractional seconds; both are valid server dates, so a value that
    /// misses one is retried against the other.
    static let internetDateTime: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = .autoupdatingCurrent
        return formatter
    }()

    static let mediumDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.dateStyle = .medium
        return formatter
    }()

    /// A month and day in the reader's own order — "April 7" or "7 April".
    static let monthAndDay: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.setLocalizedDateFormatFromTemplate("MMMMd")
        return formatter
    }()

    /// Month names, indexed from zero. Read through a shared formatter rather
    /// than building one per name: these are drawn in pickers and lists.
    static var monthSymbols: [String] { monthNames.monthSymbols }

    private static let monthNames: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        return formatter
    }()

    /// `yyyy-MM-dd`, as a calendar date with no time or zone of its own.
    static let calendarDay: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}

extension ISO8601DateFormatter {
    static let assistant: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

extension String {
    var assistantDate: Date? { ISO8601DateFormatter.assistant.date(from: self) }

    var sentenceCaseIdentifier: String {
        switch self.lowercased() {
        case "adhoc":
            return "Ad hoc"
        case "waiting_approval":
            return "Waiting for approval"
        case "waiting_budget":
            return "Waiting for budget"
        case "waiting_event":
            return "Waiting for an event"
        case "needs_attention":
            return "Needs attention"
        default:
            break
        }

        return replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: ".", with: " ")
            .capitalized
    }

    var isMachineIdentifier: Bool {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains(where: \.isWhitespace) else { return false }
        return trimmed.contains("_")
            || trimmed.contains("-")
            || trimmed.contains(".")
            || trimmed == trimmed.lowercased()
    }
}

struct WorkspaceRepairs: Codable, Sendable {
    let enabled: Bool
    let configured: Bool
    let dailyLimit: Int
    let issues: [WorkspaceRepairIssue]
}
struct WorkspaceRepairIssue: Codable, Identifiable, Sendable {
    let id: String
    let title: String
    let summary: String
    let status: String
    let diagnosis: String
    let lastError: String
    let sourceTaskId: String?
    let prUrl: String?
    let runUrl: String?
    var manualRunRequested: Bool? = nil
    var queuePosition: Int? = nil
    var waitingReason: String? = nil
    let updatedAt: String
    var mergeSha: String? = nil
    var history: [WorkspaceRepairHistory]? = nil
    var outcome: WorkspaceRepairOutcome? = nil
    var deploymentConfirmed: Bool? = nil
    var createdAt: String? = nil

    var actionRevision: String { "\(status)|\(updatedAt)|\(manualRunRequested == true)" }
}

struct WorkspaceRepairOutcome: Codable, Sendable {
    let message: String
    let nextStep: String
}

struct WorkspaceRepairHistory: Codable, Sendable {
    let status: String
    let at: String
    let detail: String
}

/// Repair states describe different evidence milestones, not a progress score.
/// Test execution, merge, deployment and owner confirmation are kept distinct.
struct RepairPresentation: Equatable, Sendable {
    let title: String
    let detail: String
    let isClosed: Bool
    let canDismiss: Bool
    let canRetry: Bool
    let canRequestManualRun: Bool
    let canConfirmFixed: Bool

    init(status: String, manualRunRequested: Bool = false, deploymentConfirmed: Bool = false) {
        isClosed = ["resolved", "dismissed"].contains(status)
        canDismiss = ["reported", "merged", "monitoring", "blocked", "failed"].contains(status)
        canRetry = ["failed", "blocked"].contains(status)
        canRequestManualRun = ["reported", "failed", "blocked"].contains(status) && !manualRunRequested
        canConfirmFixed = status == "monitoring" && deploymentConfirmed
        switch status {
        case "reported":
            title = manualRunRequested ? "Manual run requested" : "Queued"
            detail = "The report is waiting for investigation."
        case "investigating":
            title = "Investigating"
            detail = "The assistant is checking the report and its evidence."
        case "fixing":
            title = "Preparing fix"
            detail = "A coding attempt is in progress."
        case "testing":
            title = "Testing"
            detail = "Checks are in progress. Results are not yet confirmed."
        case "pr_open":
            title = "Pull request ready for review"
            detail = "Review the proposed code and its checks before merging."
        case "merged":
            title = "Awaiting deployment"
            detail = "The code was merged. Deployment has not yet been observed."
        case "monitoring":
            title = deploymentConfirmed ? "Deployed · needs confirmation" : "Deployment evidence unavailable"
            detail = deploymentConfirmed ? "Deployment was detected. Check the original problem before confirming it is fixed." : "A monitoring status alone does not prove deployment. Review the recorded release evidence."
        case "resolved":
            title = "Confirmed fixed"
            detail = "The owner marked the original problem as fixed."
        case "blocked":
            title = "Needs attention"
            detail = "Review the reason before starting another attempt."
        case "failed":
            title = "Fix attempt failed"
            detail = "Review the attempt and its error before retrying."
        case "dismissed":
            title = "Dismissed"
            detail = "This report is no longer in the queue."
        default:
            title = "Status unavailable"
            detail = "Refresh to check this report’s current state."
        }
    }
}
