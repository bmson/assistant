import Foundation

/// A composer belongs to one conversation in one authenticated session.
/// The session prevents a disappearing view from saving into a new account.
struct ComposerDraftScope: Equatable {
    let session: Int
    let conversationID: String
}

/// Unsent text remains on this device for this app session. It is never
/// uploaded, indexed as memory, or evicted while the owner is editing it.
struct ConversationDrafts {
    private(set) var session = 0
    private var text: [String: String] = [:]
    private var recovery: [String: String] = [:]

    func scope(conversationID: String) -> ComposerDraftScope {
        .init(session: session, conversationID: conversationID)
    }

    func draft(in scope: ComposerDraftScope) -> String {
        scope.session == session ? text[scope.conversationID] ?? "" : ""
    }

    mutating func save(_ draft: String, in scope: ComposerDraftScope) {
        guard scope.session == session else { return }
        if draft.isEmpty { text.removeValue(forKey: scope.conversationID) }
        else { text[scope.conversationID] = draft }
    }

    mutating func preserveUnsent(_ draft: String, in scope: ComposerDraftScope) {
        guard scope.session == session else { return }
        recovery[scope.conversationID] = draft
    }

    func hasRecovery(in scope: ComposerDraftScope) -> Bool {
        scope.session == session && recovery[scope.conversationID] != nil
    }

    /// Never replace a follow-up the owner typed while the send was pending.
    mutating func restore(in scope: ComposerDraftScope, replacing draft: String) -> String? {
        guard scope.session == session,
              draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let restored = recovery.removeValue(forKey: scope.conversationID) else { return nil }
        save(restored, in: scope)
        return restored
    }

    mutating func reset() {
        session += 1
        text.removeAll()
        recovery.removeAll()
    }
}
