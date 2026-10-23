import Foundation

/// A composer belongs to one conversation in one authenticated session.
/// The session prevents a disappearing view from saving into a new account.
struct ComposerDraftScope: Equatable {
    let session: Int
    let conversationID: String
}

/// Draft and recovery changes have separate versions: recovery arriving must
/// not invalidate an editor's pending final keystroke.
struct ComposerDraftSnapshot: Equatable {
    let scope: ComposerDraftScope
    let revision: UInt64
    let recoveryRevision: UInt64
    let text: String

    func adoptingRecoverySnapshot(_ current: ComposerDraftSnapshot,
                                  localDraft: String) -> ComposerDraftSnapshot? {
        guard scope == current.scope, revision == current.revision,
              localDraft == text, text == current.text else { return nil }
        return current
    }
}

/// Captures the draft state when a user submits a message. Staging submitted
/// text is safe only when this view began the submission with an empty draft.
struct ComposerDraftSubmissionContext {
    let origin: ComposerDraftSnapshot
    let mayStageSubmittedText: Bool

    init(origin: ComposerDraftSnapshot, localDraft: String) {
        self.origin = origin
        mayStageSubmittedText = localDraft.isEmpty && origin.text.isEmpty
    }
}

/// Only the successful staging write can supply this token. It is retained
/// separately from the editor's ordinary snapshot and never supplies UI text.
struct ComposerDraftSubmissionProvenance {
    let origin: ComposerDraftSnapshot
    let staged: ComposerDraftSnapshot

    fileprivate func matchesOrigin(_ snapshot: ComposerDraftSnapshot) -> Bool {
        snapshot.scope == origin.scope && snapshot.revision == origin.revision
            && snapshot.text == origin.text && origin.text.isEmpty
            && staged.scope == origin.scope && staged.revision > origin.revision
            && !staged.text.isEmpty
    }
}

extension ComposerDraftSnapshot {
    func capturingSubmissionStage(
        _ submission: ComposerDraftSubmissionProvenance,
        current: ComposerDraftSnapshot,
        localDraft: String,
        activeScope: ComposerDraftScope?,
        isVisible: Bool
    ) -> ComposerDraftSubmissionProvenance? {
        guard isVisible, activeScope == scope, localDraft == text,
              submission.matchesOrigin(self),
              current == submission.staged else { return nil }
        return submission
    }

    /// A pending final edit may supersede this editor's own submission stage.
    /// The store must still CAS this captured token; never refresh it at close.
    func lifecycleFlushSnapshot(
        localDraft: String,
        submission: ComposerDraftSubmissionProvenance?
    ) -> ComposerDraftSnapshot {
        guard let submission, submission.matchesOrigin(self),
              !localDraft.isEmpty else { return self }
        return submission.staged
    }

    /// Adopts the latest empty snapshot after this submission cleared its own
    /// draft, while allowing recovery-only changes since the submit began.
    func adoptingSubmissionClear(
        _ cleared: ComposerDraftSnapshot,
        from origin: ComposerDraftSnapshot,
        current: ComposerDraftSnapshot,
        localDraft: String,
        activeScope: ComposerDraftScope?,
        isVisible: Bool
    ) -> ComposerDraftSnapshot? {
        guard isVisible,
              activeScope == scope,
              scope == origin.scope,
              revision == origin.revision,
              text == origin.text,
              origin.text.isEmpty,
              localDraft == origin.text,
              cleared.scope == scope,
              cleared.text.isEmpty,
              current == cleared else { return nil }
        return cleared
    }
}

/// Unsent text remains on this device for this app session. It is never
/// uploaded, indexed as memory, or evicted while the owner is editing it.
struct ConversationDrafts {
    private(set) var session = 0
    private var text: [String: String] = [:]
    // Keep empty-value revisions as tombstones so a clear cannot make an old
    // snapshot valid again (the ABA case).
    private var revisions: [String: UInt64] = [:]
    private var recoveryRevisions: [String: UInt64] = [:]
    private var recovery: [String: String] = [:]

    func scope(conversationID: String) -> ComposerDraftScope {
        .init(session: session, conversationID: conversationID)
    }

    func draft(in scope: ComposerDraftScope) -> String {
        scope.session == session ? text[scope.conversationID] ?? "" : ""
    }

    func snapshot(in scope: ComposerDraftScope) -> ComposerDraftSnapshot? {
        guard scope.session == session else { return nil }
        return ComposerDraftSnapshot(
            scope: scope,
            revision: revisions[scope.conversationID] ?? 0,
            recoveryRevision: recoveryRevisions[scope.conversationID] ?? 0,
            text: text[scope.conversationID] ?? ""
        )
    }

    @discardableResult
    mutating func save(_ draft: String, in scope: ComposerDraftScope) -> ComposerDraftSnapshot? {
        guard scope.session == session, write(draft, in: scope) else { return nil }
        return snapshot(in: scope)
    }

    @discardableResult
    mutating func save(
        _ draft: String,
        in scope: ComposerDraftScope,
        ifUnchangedFrom snapshot: ComposerDraftSnapshot
    ) -> ComposerDraftSnapshot? {
        guard snapshot.scope == scope,
              let current = self.snapshot(in: scope),
              current.revision == snapshot.revision else { return nil }
        return save(draft, in: scope)
    }

    private mutating func write(_ draft: String, in scope: ComposerDraftScope) -> Bool {
        let revision = revisions[scope.conversationID] ?? 0
        guard revision < UInt64.max else { return false }
        if draft.isEmpty { text.removeValue(forKey: scope.conversationID) }
        else { text[scope.conversationID] = draft }
        revisions[scope.conversationID] = revision + 1
        return true
    }

    mutating func preserveUnsent(_ draft: String, in scope: ComposerDraftScope) {
        guard scope.session == session else { return }
        let revision = recoveryRevisions[scope.conversationID] ?? 0
        guard revision < UInt64.max else { return }
        recovery[scope.conversationID] = draft
        recoveryRevisions[scope.conversationID] = revision + 1
    }

    func hasRecovery(in scope: ComposerDraftScope) -> Bool {
        scope.session == session && recovery[scope.conversationID] != nil
    }

    /// Never replace a follow-up the owner typed while the send was pending.
    mutating func restore(in scope: ComposerDraftScope, replacing draft: String) -> String? {
        guard scope.session == session,
              draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let restored = recovery[scope.conversationID],
              consumeRecovery(restored, in: scope) != nil else { return nil }
        return restored
    }

    /// Restores only if the view's paired snapshot is still the current empty
    /// value. A newer save or recovery invalidates the token and keeps recovery.
    @discardableResult
    mutating func restore(
        in scope: ComposerDraftScope,
        replacing draft: String,
        ifUnchangedFrom snapshot: ComposerDraftSnapshot
    ) -> ComposerDraftSnapshot? {
        guard snapshot.scope == scope,
              snapshot.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let current = self.snapshot(in: scope),
              current.revision == snapshot.revision,
              current.recoveryRevision == snapshot.recoveryRevision,
              current.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let restored = recovery[scope.conversationID] else { return nil }
        return consumeRecovery(restored, in: scope)
    }

    private mutating func consumeRecovery(_ restored: String,
                                         in scope: ComposerDraftScope) -> ComposerDraftSnapshot? {
        let revision = recoveryRevisions[scope.conversationID] ?? 0
        guard revision < UInt64.max, write(restored, in: scope) else { return nil }
        recovery.removeValue(forKey: scope.conversationID)
        recoveryRevisions[scope.conversationID] = revision + 1
        return snapshot(in: scope)
    }

    mutating func reset() {
        session += 1
        text.removeAll()
        revisions.removeAll()
        recoveryRevisions.removeAll()
        recovery.removeAll()
    }
}
