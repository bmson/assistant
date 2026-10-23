#if ASSISTANT_SCROLL_FIXTURE
import Foundation

// Reused fixture shapes; 500 rows represent retained long-session history.
enum ScrollFixtureData {
    static let ownerID = "11111111-1111-4111-8111-111111111111"
    static let conversationID = "22222222-2222-4222-8222-222222222222"
    static func messages(count: Int) -> [ChatMessage] {
        let sources = [
            MessageRecallSource(date: "2026-10-18", label: "A previous conversation about the weekend plan and the confirmed arrival details", kind: "chat", hops: 1, surfaceKey: nil, sourceRevision: nil),
            MessageRecallSource(date: "2026-10-17", label: "Prefers quiet hotels close to the station", kind: "knowledge_graph", hops: 2,
                                surfaceKey: String(repeating: "a", count: 64), sourceRevision: String(repeating: "b", count: 64)),
            MessageRecallSource(date: "2026-10-16", label: "Choose a refundable room before confirming the train", kind: "situation_decision", hops: 1,
                                surfaceKey: String(repeating: "c", count: 64), sourceRevision: String(repeating: "d", count: 64)),
            MessageRecallSource(date: "2026-10-15", label: "Confirm the late arrival window with the hotel", kind: "commitment", hops: 1,
                                surfaceKey: String(repeating: "e", count: 64), sourceRevision: String(repeating: "f", count: 64)),
        ]
        return (0..<count).map { index in
            if index.isMultiple(of: 2) {
                return .optimistic(role: .user,
                    text: index.isMultiple(of: 10)
                        ? "Can you compare the options, keep our earlier decision in view, and tell me what still needs confirmation?"
                        : "Please check the weekend details and keep the plan flexible.",
                    id: "scroll-bench-user-\(index)")
            }

            let assistantIndex = index / 2
            var parts: [MessagePart] = [.init(type: "text", text: assistantIndex.isMultiple(of: 3)
                ? "**Harbor House** is close to the station.\n\nThe cancellation window stays open until Thursday, and the train arrives at 4:30 PM.\n\n- Keep the confirmation nearby.\n- Ask before changing the booking."
                : "The train arrives at 4:30 PM, and the hotel can hold the room until 5 PM. This leaves time to collect the bags and walk over.")]
            if assistantIndex.isMultiple(of: 4) { parts.append(.init(type: "recall", sources: sources)) }
            if assistantIndex.isMultiple(of: 10) {
                parts.append(.init(type: "data-card", data: .object([
                    "kind": .string("proactive-alert"), "id": .string("scroll-alert-\(assistantIndex)"),
                    "category": .string("travel"), "urgencyLabel": .string("Worth your attention"),
                    "title": .string("Confirm the late arrival window"),
                    "summary": .string("The hotel may need an updated arrival time before the weekend."),
                    "details": .array([.object(["label": .string("Hotel"), "value": .string("Harbor House")])]),
                ])))
            }
            return ChatMessage(id: "scroll-bench-assistant-\(index)", role: .assistant, parts: parts)
        }
    }

    static func bootstrap(messages: [ChatMessage]) throws -> Data {
        let conversation = ConversationView(
            conversation: .init(
                id: conversationID,
                title: "Performance fixture",
                modelOverride: nil,
                archivedAt: nil,
                isPrimary: true
            ),
            agentName: "Fixture Assistant",
            agentTimezone: "UTC",
            messages: messages,
            models: [],
            goalTitle: nil,
            canArchive: false,
            cursor: "performance-start",
            asyncTurn: nil
        )
        let response = BootstrapResponse(
            generatedAt: "2026-10-22T12:00:00Z",
            identity: .init(id: ownerID, name: "Performance Owner", avatarUrl: nil),
            shell: .init(
                dashboard: .init(pendingApprovals: 0, needsAttention: 0, presence: .idle),
                memoryHealth: .init(
                    totalUsable: 0,
                    notYetOrganized: 0,
                    awaitingReview: 0,
                    ownerConfirmed: 0,
                    lastOrganizedAt: nil
                )
            ),
            conversation: conversation
        )
        return try JSONEncoder().encode(response)
    }

}
#endif
