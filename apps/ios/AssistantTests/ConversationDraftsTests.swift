import XCTest
import SwiftUI
@testable import Assistant

final class ConversationDraftsTests: XCTestCase {
    private let sessionLock = NSLock()
    private var testSessions: [URLSession] = []
    private var testCaseID = ""

    override func setUp() {
        super.setUp()
        testCaseID = UUID().uuidString
        StubURLProtocol.beginTestCase(testCaseID)
    }

    override func tearDown() {
        StubURLProtocol.endTestCase(testCaseID)
        let sessions = sessionLock.withLock { () -> [URLSession] in
            defer { testSessions = [] }
            return testSessions
        }
        for session in sessions {
            session.getAllTasks { tasks in tasks.forEach { $0.cancel() } }
        }
        super.tearDown()
    }
    func testSwitchingChatsRestoresEachUnsentDraft() {
        var drafts = ConversationDrafts()
        let main = drafts.scope(conversationID: "main")
        let side = drafts.scope(conversationID: "side")
        drafts.save("Book a quiet hotel", in: main)
        drafts.save("Compare these dates", in: side)
        XCTAssertEqual(drafts.draft(in: main), "Book a quiet hotel")
        XCTAssertEqual(drafts.draft(in: side), "Compare these dates")
        drafts.save("", in: side)
        XCTAssertEqual(drafts.draft(in: side), "")
        XCTAssertEqual(drafts.draft(in: main), "Book a quiet hotel")
    }

    func testFailedSendNeverOverwritesAFollowUp() {
        var drafts = ConversationDrafts()
        let scope = drafts.scope(conversationID: "main")
        drafts.preserveUnsent("The message that failed", in: scope)
        drafts.save("A follow-up I am still writing", in: scope)
        XCTAssertNil(drafts.restore(in: scope, replacing: drafts.draft(in: scope)))
        XCTAssertEqual(drafts.draft(in: scope), "A follow-up I am still writing")
        XCTAssertTrue(drafts.hasRecovery(in: scope))
        XCTAssertEqual(drafts.restore(in: scope, replacing: " \n"), "The message that failed")
        XCTAssertEqual(drafts.draft(in: scope), "The message that failed")
        XCTAssertFalse(drafts.hasRecovery(in: scope))
        XCTAssertNil(drafts.restore(in: scope, replacing: ""))
    }

    func testFailureRecoveryBelongsToItsConversation() {
        var drafts = ConversationDrafts()
        let main = drafts.scope(conversationID: "main")
        let side = drafts.scope(conversationID: "side")
        drafts.preserveUnsent("Unsent in main", in: main)
        XCTAssertNil(drafts.restore(in: side, replacing: ""))
        XCTAssertFalse(drafts.hasRecovery(in: side))
        XCTAssertEqual(drafts.restore(in: main, replacing: ""), "Unsent in main")
    }

    func testAccountChangeClearsDraftsAndRejectsDisappearingViews() {
        var drafts = ConversationDrafts()
        let old = drafts.scope(conversationID: "same-id")
        drafts.save("Private old account text", in: old)
        drafts.preserveUnsent("Private failed turn", in: old)
        drafts.reset()
        let current = drafts.scope(conversationID: "same-id")
        XCTAssertNotEqual(old, current)
        drafts.save("A delayed disappearing view", in: old)
        drafts.preserveUnsent("A delayed old failure", in: old)
        XCTAssertEqual(drafts.draft(in: current), "")
        XCTAssertEqual(drafts.draft(in: old), "")
        XCTAssertFalse(drafts.hasRecovery(in: current))
        XCTAssertNil(drafts.restore(in: old, replacing: ""))
        drafts.save("Current account text", in: current)
        XCTAssertEqual(drafts.draft(in: current), "Current account text")
    }

    func testDraftContentPreservesWhitespaceAndUnicode() {
        var drafts = ConversationDrafts()
        let scope = drafts.scope(conversationID: "main")
        let text = "  Halló 👋\n\nKeep my formatting.  "
        drafts.save(text, in: scope)
        XCTAssertEqual(drafts.draft(in: scope), text)
        drafts.preserveUnsent(text, in: scope)
        XCTAssertEqual(drafts.restore(in: scope, replacing: ""), text)
    }

    func testCompareAndSaveRejectsStaleTeardownWithoutChangingCurrentDraft() throws {
        var drafts = ConversationDrafts()
        let scope = drafts.scope(conversationID: "main")
        let staleView = try XCTUnwrap(drafts.snapshot(in: scope))
        drafts.preserveUnsent("Recovery remains available", in: scope)
        let currentView = try XCTUnwrap(drafts.save("Current view text", in: scope))

        for staleText in ["", "Older nonempty view text"] {
            XCTAssertNil(drafts.save(staleText, in: scope, ifUnchangedFrom: staleView))
            XCTAssertEqual(drafts.snapshot(in: scope), currentView)
            XCTAssertEqual(drafts.draft(in: scope), "Current view text")
            XCTAssertTrue(drafts.hasRecovery(in: scope))
        }
    }

    func testCompareAndSaveAcceptsPendingLastKeystrokeWhenSnapshotIsCurrent() throws {
        var drafts = ConversationDrafts()
        let scope = drafts.scope(conversationID: "main")
        _ = drafts.save("The text before the final key", in: scope)
        let view = try XCTUnwrap(drafts.snapshot(in: scope))

        let saved = try XCTUnwrap(
            drafts.save("The text before the final key!", in: scope, ifUnchangedFrom: view)
        )
        XCTAssertEqual(saved.text, "The text before the final key!")
        XCTAssertGreaterThan(saved.revision, view.revision)
        XCTAssertEqual(drafts.draft(in: scope), saved.text)
    }

    func testSameTextWritesAndClearsAdvanceRetainedRevision() throws {
        var drafts = ConversationDrafts()
        let scope = drafts.scope(conversationID: "main")
        let initiallyEmpty = try XCTUnwrap(drafts.snapshot(in: scope))
        let first = try XCTUnwrap(drafts.save("same", in: scope))
        let afterClearToValue = try XCTUnwrap(drafts.save("same", in: scope))

        XCTAssertGreaterThan(afterClearToValue.revision, first.revision)
        XCTAssertNil(drafts.save("stale", in: scope, ifUnchangedFrom: first))
        XCTAssertEqual(drafts.snapshot(in: scope), afterClearToValue)
        XCTAssertFalse(drafts.hasRecovery(in: scope))

        let cleared = try XCTUnwrap(drafts.save("", in: scope, ifUnchangedFrom: afterClearToValue))
        XCTAssertEqual(cleared.text, "")
        XCTAssertGreaterThan(cleared.revision, afterClearToValue.revision)
        XCTAssertEqual(drafts.snapshot(in: scope), cleared)
        XCTAssertNil(drafts.save("old empty", in: scope, ifUnchangedFrom: initiallyEmpty))
        XCTAssertEqual(drafts.snapshot(in: scope), cleared)
    }

    func testCompareAndSaveRejectsCrossScopeAndInvalidSessionTokens() throws {
        var drafts = ConversationDrafts()
        let oldScope = drafts.scope(conversationID: "main")
        let otherScope = drafts.scope(conversationID: "side")
        let oldSnapshot = try XCTUnwrap(drafts.snapshot(in: oldScope))
        let otherBefore = try XCTUnwrap(drafts.snapshot(in: otherScope))
        XCTAssertNil(drafts.save("wrong conversation", in: otherScope, ifUnchangedFrom: oldSnapshot))
        XCTAssertEqual(drafts.snapshot(in: otherScope), otherBefore)
        XCTAssertFalse(drafts.hasRecovery(in: otherScope))

        drafts.reset()
        XCTAssertNil(drafts.snapshot(in: oldScope))
        let currentScope = drafts.scope(conversationID: "main")
        let currentBefore = try XCTUnwrap(drafts.snapshot(in: currentScope))
        XCTAssertNil(drafts.save("old session", in: oldScope, ifUnchangedFrom: oldSnapshot))
        XCTAssertNil(drafts.restore(in: currentScope, replacing: "", ifUnchangedFrom: oldSnapshot))
        XCTAssertEqual(drafts.snapshot(in: currentScope), currentBefore)
        XCTAssertFalse(drafts.hasRecovery(in: currentScope))
        XCTAssertEqual(drafts.draft(in: currentScope), "")
    }

    func testConditionalRecoveryIsAtomicAndRejectedRecoveryPreservesNewText() throws {
        var drafts = ConversationDrafts()
        let scope = drafts.scope(conversationID: "main")
        drafts.preserveUnsent("Failed message", in: scope)
        let beforeRecoveryRestore = try XCTUnwrap(drafts.snapshot(in: scope))
        _ = drafts.save("Follow-up typed later", in: scope)
        let newer = try XCTUnwrap(drafts.snapshot(in: scope))

        XCTAssertNil(drafts.restore(in: scope, replacing: "", ifUnchangedFrom: beforeRecoveryRestore))
        XCTAssertEqual(drafts.snapshot(in: scope), newer)
        XCTAssertEqual(drafts.draft(in: scope), "Follow-up typed later")
        XCTAssertTrue(drafts.hasRecovery(in: scope))

        XCTAssertNil(drafts.restore(in: scope, replacing: "", ifUnchangedFrom: newer))
        XCTAssertEqual(drafts.snapshot(in: scope), newer)
        XCTAssertEqual(drafts.draft(in: scope), "Follow-up typed later")
        XCTAssertTrue(drafts.hasRecovery(in: scope))

        XCTAssertNil(drafts.restore(in: scope, replacing: "A newer local keystroke", ifUnchangedFrom: newer))
        XCTAssertEqual(drafts.snapshot(in: scope), newer)
        XCTAssertTrue(drafts.hasRecovery(in: scope))
    }

    func testConditionalRecoveryConsumesOnceAndKeepsExplicitRestoreCompatible() throws {
        var drafts = ConversationDrafts()
        let scope = drafts.scope(conversationID: "main")
        drafts.preserveUnsent("One-shot recovery", in: scope)
        let empty = try XCTUnwrap(drafts.snapshot(in: scope))
        let restored = try XCTUnwrap(
            drafts.restore(in: scope, replacing: " \n", ifUnchangedFrom: empty)
        )
        XCTAssertEqual(restored.text, "One-shot recovery")
        XCTAssertGreaterThan(restored.revision, empty.revision)
        XCTAssertGreaterThan(restored.recoveryRevision, empty.recoveryRevision)
        XCTAssertFalse(drafts.hasRecovery(in: scope))
        XCTAssertNil(drafts.restore(in: scope, replacing: "", ifUnchangedFrom: empty))
        XCTAssertEqual(drafts.snapshot(in: scope), restored)

        drafts.save("", in: scope)
        drafts.preserveUnsent("Explicit API recovery", in: scope)
        XCTAssertEqual(drafts.restore(in: scope, replacing: ""), "Explicit API recovery")
        XCTAssertFalse(drafts.hasRecovery(in: scope))
    }

    func testPendingCloseSurvivesRecoveryOnlyChangesAndUsesItsOldScope() throws {
        var drafts = ConversationDrafts()
        let scope = drafts.scope(conversationID: "main")
        let other = drafts.scope(conversationID: "side")
        let editor = try XCTUnwrap(drafts.save("Typed", in: scope))
        let otherBefore = try XCTUnwrap(drafts.save("Other conversation", in: other))
        drafts.preserveUnsent("Failed message", in: scope)
        let recoveryArrived = try XCTUnwrap(drafts.snapshot(in: scope))
        XCTAssertEqual(recoveryArrived.revision, editor.revision)
        XCTAssertGreaterThan(recoveryArrived.recoveryRevision, editor.recoveryRevision)

        let closed = try XCTUnwrap(drafts.save("Typed!", in: scope, ifUnchangedFrom: editor))
        XCTAssertEqual(closed.text, "Typed!")
        XCTAssertEqual(closed.recoveryRevision, recoveryArrived.recoveryRevision)
        XCTAssertTrue(drafts.hasRecovery(in: scope))
        XCTAssertEqual(drafts.snapshot(in: other), otherBefore)
        let next = try XCTUnwrap(drafts.save("Typed! Dictated", in: scope))
        let final = try XCTUnwrap(drafts.save("Typed! Dictated.", in: scope, ifUnchangedFrom: next))
        XCTAssertEqual(final.text, "Typed! Dictated.")
    }

    func testReplacementRecoveryFencesRestoreButNotLifecycleSave() throws {
        var drafts = ConversationDrafts()
        let scope = drafts.scope(conversationID: "main")
        drafts.preserveUnsent("First recovery", in: scope)
        let old = try XCTUnwrap(drafts.snapshot(in: scope))
        drafts.preserveUnsent("Newer recovery", in: scope)
        let current = try XCTUnwrap(drafts.snapshot(in: scope))
        XCTAssertEqual(current.revision, old.revision)
        XCTAssertGreaterThan(current.recoveryRevision, old.recoveryRevision)
        XCTAssertNil(drafts.restore(in: scope, replacing: "", ifUnchangedFrom: old))
        XCTAssertEqual(drafts.snapshot(in: scope), current)
        XCTAssertTrue(drafts.hasRecovery(in: scope))

        let adopted = try XCTUnwrap(old.adoptingRecoverySnapshot(current, localDraft: ""))
        let restored = try XCTUnwrap(drafts.restore(in: scope, replacing: "", ifUnchangedFrom: adopted))
        XCTAssertEqual(restored.text, "Newer recovery")
        XCTAssertFalse(drafts.hasRecovery(in: scope))
        XCTAssertNil(drafts.restore(in: scope, replacing: "", ifUnchangedFrom: adopted))
        XCTAssertEqual(drafts.snapshot(in: scope), restored)

        let empty = try XCTUnwrap(drafts.save("", in: scope))
        drafts.preserveUnsent("Another recovery", in: scope)
        let closed = try XCTUnwrap(drafts.save("Pending key", in: scope, ifUnchangedFrom: empty))
        XCTAssertEqual(closed.text, "Pending key")
        XCTAssertTrue(drafts.hasRecovery(in: scope))
    }

    func testOwnClearReturnsTheTokenForAValidFinalSave() throws {
        var drafts = ConversationDrafts()
        let scope = drafts.scope(conversationID: "main")
        let typed = try XCTUnwrap(drafts.save("Message submitted", in: scope))
        let cleared = try XCTUnwrap(drafts.save("", in: scope))
        let closed = try XCTUnwrap(drafts.save("", in: scope, ifUnchangedFrom: cleared))
        XCTAssertEqual(closed.text, "")
        XCTAssertGreaterThan(closed.revision, cleared.revision)
        XCTAssertNil(drafts.save("Old text", in: scope, ifUnchangedFrom: typed))
        XCTAssertEqual(drafts.snapshot(in: scope), closed)
        XCTAssertFalse(drafts.hasRecovery(in: scope))
    }

    func testRecoverySnapshotAdoptionRejectsPendingTextWhitespaceAndExternalWrites() throws {
        var drafts = ConversationDrafts()
        let scope = drafts.scope(conversationID: "main")
        let old = try XCTUnwrap(drafts.snapshot(in: scope))
        drafts.preserveUnsent("Recovery", in: scope)
        let current = try XCTUnwrap(drafts.snapshot(in: scope))
        for pending in ["New key", " ", "\n"] {
            XCTAssertNil(old.adoptingRecoverySnapshot(current, localDraft: pending))
            XCTAssertNil(drafts.restore(in: scope, replacing: pending, ifUnchangedFrom: old))
            XCTAssertEqual(drafts.snapshot(in: scope), current)
            XCTAssertTrue(drafts.hasRecovery(in: scope))
        }

        let external = try XCTUnwrap(drafts.save("External write", in: scope))
        XCTAssertNil(old.adoptingRecoverySnapshot(external, localDraft: ""))
        XCTAssertEqual(drafts.snapshot(in: scope), external)
        XCTAssertTrue(drafts.hasRecovery(in: scope))
        let cleared = try XCTUnwrap(drafts.save("", in: scope))
        XCTAssertNil(old.adoptingRecoverySnapshot(cleared, localDraft: ""))
        XCTAssertNil(drafts.save("ABA stale", in: scope, ifUnchangedFrom: old))
        XCTAssertEqual(drafts.snapshot(in: scope), cleared)
        XCTAssertTrue(drafts.hasRecovery(in: scope))

        let other = drafts.scope(conversationID: "side")
        let otherBefore = try XCTUnwrap(drafts.snapshot(in: other))
        XCTAssertNil(old.adoptingRecoverySnapshot(otherBefore, localDraft: ""))
        XCTAssertNil(drafts.restore(in: other, replacing: "", ifUnchangedFrom: cleared))
        XCTAssertEqual(drafts.snapshot(in: scope), cleared)
        XCTAssertEqual(drafts.snapshot(in: other), otherBefore)
        XCTAssertFalse(drafts.hasRecovery(in: other))
    }

    func testSubmissionContextOnlyStagesFromAnActuallyEmptyEditor() throws {
        var drafts = ConversationDrafts()
        let scope = drafts.scope(conversationID: "main")
        let emptyOrigin = try XCTUnwrap(drafts.snapshot(in: scope))
        XCTAssertTrue(ComposerDraftSubmissionContext(origin: emptyOrigin, localDraft: "").mayStageSubmittedText)

        for localDraft in ["Pending text", " ", "\n"] {
            XCTAssertFalse(ComposerDraftSubmissionContext(
                origin: emptyOrigin, localDraft: localDraft
            ).mayStageSubmittedText)
        }

        let nonemptyOrigin = try XCTUnwrap(drafts.save("Already typing", in: scope))
        XCTAssertFalse(ComposerDraftSubmissionContext(
            origin: nonemptyOrigin, localDraft: nonemptyOrigin.text
        ).mayStageSubmittedText)
    }

    func testOwnSubmissionStageOnlyAuthorizesChangedPendingLocalDraft() throws {
        for pending in ["Pending final key", " \n"] {
            var drafts = ConversationDrafts()
            let scope = drafts.scope(conversationID: "main")
            let origin = try XCTUnwrap(drafts.snapshot(in: scope))
            let staged = try XCTUnwrap(drafts.save("Submitted message", in: scope, ifUnchangedFrom: origin))
            let submission = ComposerDraftSubmissionProvenance(origin: origin, staged: staged)
            let captured = try XCTUnwrap(origin.capturingSubmissionStage(
                submission, current: staged, localDraft: "", activeScope: scope, isVisible: true
            ))
            XCTAssertEqual(origin.lifecycleFlushSnapshot(localDraft: "", submission: captured), origin)
            XCTAssertNil(drafts.save("", in: scope, ifUnchangedFrom:
                origin.lifecycleFlushSnapshot(localDraft: "", submission: captured)))
            XCTAssertEqual(drafts.snapshot(in: scope), staged)

            drafts.preserveUnsent("Separate recovery", in: scope)
            // Recovery alone does not invalidate either the retained origin
            // or the staged draft token used by the final pending edit.
            let recoveryOnlyOrigin = ComposerDraftSnapshot(
                scope: scope, revision: origin.revision, recoveryRevision: 1, text: origin.text
            )
            let token = recoveryOnlyOrigin.lifecycleFlushSnapshot(localDraft: pending, submission: captured)
            XCTAssertEqual(token, staged)
            let saved = try XCTUnwrap(drafts.save(pending, in: scope, ifUnchangedFrom: token))
            XCTAssertEqual(saved.text, pending)
            XCTAssertTrue(drafts.hasRecovery(in: scope))
            XCTAssertNil(drafts.save("Repeated stale flush", in: scope, ifUnchangedFrom: token))
            XCTAssertEqual(drafts.snapshot(in: scope), saved)
            XCTAssertEqual(saved.lifecycleFlushSnapshot(localDraft: "Next key", submission: captured), saved)
        }
    }

    func testSubmissionStageRejectsInactiveReceiptAndUnrelatedStorageChanges() throws {
        var drafts = ConversationDrafts()
        let scope = drafts.scope(conversationID: "main")
        let origin = try XCTUnwrap(drafts.snapshot(in: scope))
        let staged = try XCTUnwrap(drafts.save("Submitted message", in: scope))
        let submission = ComposerDraftSubmissionProvenance(origin: origin, staged: staged)
        for visible in [false, true] {
            XCTAssertNil(origin.capturingSubmissionStage(
                submission, current: staged, localDraft: "Pending edit",
                activeScope: scope, isVisible: visible
            ))
        }
        XCTAssertNil(origin.capturingSubmissionStage(
            submission, current: staged, localDraft: "", activeScope: scope, isVisible: false
        ))
        XCTAssertNil(origin.capturingSubmissionStage(
            submission, current: staged, localDraft: "", activeScope: nil, isVisible: true
        ))
        for externalText in [staged.text, "Newer view text"] {
            let newer = try XCTUnwrap(drafts.save(externalText, in: scope))
            XCTAssertNil(origin.capturingSubmissionStage(
                submission, current: newer, localDraft: "", activeScope: scope, isVisible: true
            ))
            XCTAssertNil(drafts.save("Pending key", in: scope, ifUnchangedFrom:
                origin.lifecycleFlushSnapshot(localDraft: "Pending key", submission: submission)))
            XCTAssertEqual(drafts.snapshot(in: scope), newer)
        }
        let otherScope = drafts.scope(conversationID: "other")
        let other = try XCTUnwrap(drafts.snapshot(in: otherScope))
        XCTAssertEqual(other.lifecycleFlushSnapshot(localDraft: "Pending key", submission: submission), other)
        drafts.reset()
        let newScope = drafts.scope(conversationID: "main")
        let newSession = try XCTUnwrap(drafts.snapshot(in: newScope))
        XCTAssertEqual(newSession.lifecycleFlushSnapshot(localDraft: "Pending key", submission: submission), newSession)
        XCTAssertNil(drafts.save("Old session key", in: scope, ifUnchangedFrom: staged))
        XCTAssertEqual(drafts.snapshot(in: newScope), newSession)
    }

    func testAdoptingOwnSubmissionClearAllowsRecoveryOnlyChanges() throws {
        var drafts = ConversationDrafts()
        let scope = drafts.scope(conversationID: "main")
        let origin = try XCTUnwrap(drafts.snapshot(in: scope))
        drafts.preserveUnsent("Earlier failed message", in: scope)
        let recoveryArrived = try XCTUnwrap(drafts.snapshot(in: scope))
        XCTAssertEqual(recoveryArrived.revision, origin.revision)
        XCTAssertNotEqual(recoveryArrived.recoveryRevision, origin.recoveryRevision)

        let firstClear = try XCTUnwrap(drafts.save("", in: scope))
        let latestClear = try XCTUnwrap(drafts.save("", in: scope))
        let current = try XCTUnwrap(drafts.snapshot(in: scope))
        XCTAssertNil(recoveryArrived.adoptingSubmissionClear(
            firstClear, from: origin, current: current, localDraft: "",
            activeScope: scope, isVisible: true
        ))
        let adopted = try XCTUnwrap(recoveryArrived.adoptingSubmissionClear(
            latestClear, from: origin, current: current, localDraft: "",
            activeScope: scope, isVisible: true
        ))
        XCTAssertEqual(adopted, latestClear)
        XCTAssertEqual(drafts.snapshot(in: scope), current)
        XCTAssertTrue(drafts.hasRecovery(in: scope))
    }

    func testAdoptingSubmissionClearRejectsChangedOrInactiveEditorState() throws {
        var drafts = ConversationDrafts()
        let scope = drafts.scope(conversationID: "main")
        let origin = try XCTUnwrap(drafts.snapshot(in: scope))
        let cleared = try XCTUnwrap(drafts.save("", in: scope))
        let current = try XCTUnwrap(drafts.snapshot(in: scope))

        for localDraft in ["New keystroke", " ", "\n"] {
            XCTAssertNil(origin.adoptingSubmissionClear(
                cleared, from: origin, current: current, localDraft: localDraft,
                activeScope: scope, isVisible: true
            ))
        }
        XCTAssertNil(origin.adoptingSubmissionClear(
            cleared, from: origin, current: current, localDraft: "",
            activeScope: nil, isVisible: true
        ))
        XCTAssertNil(origin.adoptingSubmissionClear(
            cleared, from: origin, current: current, localDraft: "",
            activeScope: scope, isVisible: false
        ))

        let differentOrigin = try XCTUnwrap(drafts.save("", in: scope))
        XCTAssertNil(origin.adoptingSubmissionClear(
            cleared, from: differentOrigin, current: current, localDraft: "",
            activeScope: scope, isVisible: true
        ))
        let otherScope = drafts.scope(conversationID: "side")
        let otherSnapshot = try XCTUnwrap(drafts.snapshot(in: otherScope))
        XCTAssertNil(origin.adoptingSubmissionClear(
            otherSnapshot, from: origin, current: current, localDraft: "",
            activeScope: scope, isVisible: true
        ))

        let changed = try XCTUnwrap(drafts.save("External update", in: scope))
        XCTAssertNil(origin.adoptingSubmissionClear(
            cleared, from: origin, current: changed, localDraft: "",
            activeScope: scope, isVisible: true
        ))
        XCTAssertEqual(drafts.snapshot(in: scope), changed)
        XCTAssertEqual(drafts.draft(in: scope), "External update")
    }

    @MainActor
    func testOwnerRecoveryRequiresTheCurrentEmptyActiveComposer() async throws {
        let (model, defaults, suite) = try await pairedModel()
        defer { defaults.removePersistentDomain(forName: suite) }
        defer { if model.isSending { model.cancelSend() } }
        let scope = try XCTUnwrap(model.composerDraftScope)
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat": [.success(status: 405, body: Data(#"{"error":"Unsupported request"}"#.utf8))],
        ])

        model.send("Recover this failed message")
        let requestDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while !StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/chat" }),
              ContinuousClock.now < requestDeadline {
            await Task.yield()
        }
        XCTAssertTrue(StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/chat" }))

        let settlementDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while model.isSending, ContinuousClock.now < settlementDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertFalse(model.isSending)
        XCTAssertTrue(model.hasComposerRecovery(in: scope))
        XCTAssertEqual(model.composerDraft(in: scope), "")

        let recoveryRevision = model.composerRecoveryRevision
        let staleEditor = try XCTUnwrap(model.composerDraftSnapshot(in: scope))
        let otherScope = ComposerDraftScope(session: scope.session, conversationID: "other")
        XCTAssertNil(model.restoreComposerRecoveryByOwner(in: otherScope, replacing: ""))
        XCTAssertEqual(model.composerDraftSnapshot(in: scope), staleEditor)
        XCTAssertNil(model.restoreComposerRecoveryByOwner(in: scope, replacing: "New local key"))
        XCTAssertEqual(model.composerDraftSnapshot(in: scope), staleEditor)
        model.saveComposerDraft("A newer stored draft", in: scope)
        let newerDraft = try XCTUnwrap(model.composerDraftSnapshot(in: scope))
        XCTAssertNil(model.restoreComposerRecoveryByOwner(in: scope, replacing: ""))
        XCTAssertEqual(model.composerDraftSnapshot(in: scope), newerDraft)
        XCTAssertTrue(model.hasComposerRecovery(in: scope))
        XCTAssertEqual(model.composerDraft(in: scope), "A newer stored draft")
        XCTAssertEqual(model.composerRecoveryRevision, recoveryRevision)

        model.saveComposerDraft("", in: scope)
        let currentEmpty = try XCTUnwrap(model.composerDraftSnapshot(in: scope))
        XCTAssertNil(staleEditor.adoptingRecoverySnapshot(currentEmpty, localDraft: ""))
        XCTAssertNil(model.restoreComposerRecovery(in: scope, replacing: "", ifUnchangedFrom: staleEditor))
        XCTAssertEqual(model.composerDraftSnapshot(in: scope), currentEmpty)
        XCTAssertTrue(model.hasComposerRecovery(in: scope))
        let restored = try XCTUnwrap(model.restoreComposerRecoveryByOwner(in: scope, replacing: " \n"))
        XCTAssertEqual(restored.scope, scope)
        XCTAssertEqual(restored.text, "Recover this failed message")
        XCTAssertFalse(model.hasComposerRecovery(in: scope))
        XCTAssertEqual(model.composerDraft(in: scope), restored.text)
        XCTAssertEqual(model.composerRecoveryRevision, recoveryRevision + 1)
        XCTAssertNil(model.restoreComposerRecoveryByOwner(in: scope, replacing: ""))
        XCTAssertEqual(model.composerDraftSnapshot(in: scope), restored)
    }

    @MainActor
    func testAppModelRejectsObsoleteSaveCallbacksAndAcceptsCurrentText() async throws {
        let (model, defaults, suite) = try await pairedModel()
        defer { defaults.removePersistentDomain(forName: suite) }
        defer { if model.isSending { model.cancelSend() } }
        let scope = try XCTUnwrap(model.composerDraftScope)
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/chat": [.success(status: 405, body: Data(#"{"error":"Unsupported request"}"#.utf8))],
        ])

        model.send("Failed submission restored later")
        let requestDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while !StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/chat" }),
              ContinuousClock.now < requestDeadline {
            await Task.yield()
        }
        XCTAssertTrue(StubURLProtocol.urls.contains(where: { $0.path == "/api/mobile/v1/chat" }))
        let settlementDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while model.isSending, ContinuousClock.now < settlementDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertFalse(model.isSending)
        XCTAssertTrue(model.hasComposerRecovery(in: scope))

        let restoredText = "Failed submission restored later"
        let recovered = try XCTUnwrap(model.restoreComposerRecoveryByOwner(in: scope, replacing: ""))
        XCTAssertEqual(recovered.text, restoredText)
#if DEBUG
        var observations: [ComposerDraftSaveObservation] = []
        model.composerDraftSaveObserver = { observations.append($0) }
        defer { model.composerDraftSaveObserver = nil }
#endif

        XCTAssertNil(model.saveComposerDraftChange("", currentDraft: restoredText, in: scope))
        XCTAssertEqual(model.composerDraftSnapshot(in: scope), recovered)
        XCTAssertFalse(model.hasComposerRecovery(in: scope))
#if DEBUG
        XCTAssertTrue(observations.isEmpty, "A stale callback never reaches the save observer")
#endif

        model.saveComposerDraft("", in: scope)
        let empty = try XCTUnwrap(model.composerDraftSnapshot(in: scope))
#if DEBUG
        observations.removeAll()
#endif
        let acceptedEmpty = try XCTUnwrap(
            model.saveComposerDraftChange("", currentDraft: "", in: scope)
        )
        XCTAssertGreaterThan(acceptedEmpty.revision, empty.revision)
        XCTAssertEqual(model.composerDraftSnapshot(in: scope), acceptedEmpty)
#if DEBUG
        XCTAssertEqual(observations.map(\.accepted), [true])
#endif

        let ordinaryEdit = try XCTUnwrap(
            model.saveComposerDraftChange("ordinary edit", currentDraft: "ordinary edit", in: scope)
        )
        XCTAssertEqual(ordinaryEdit.text, "ordinary edit")
        let beforeStaleA = try XCTUnwrap(model.composerDraftSnapshot(in: scope))
#if DEBUG
        XCTAssertEqual(observations.map(\.accepted), [true, true])
#endif
        XCTAssertNil(model.saveComposerDraftChange("A", currentDraft: "B", in: scope))
        XCTAssertEqual(model.composerDraftSnapshot(in: scope), beforeStaleA)
#if DEBUG
        XCTAssertEqual(observations.map(\.accepted), [true, true])
#endif

        let acceptedB = try XCTUnwrap(
            model.saveComposerDraftChange("B", currentDraft: "B", in: scope)
        )
        XCTAssertEqual(acceptedB.text, "B")
        let repeatedB = try XCTUnwrap(
            model.saveComposerDraftChange("B", currentDraft: "B", in: scope)
        )
        XCTAssertGreaterThan(repeatedB.revision, acceptedB.revision)
        XCTAssertFalse(model.hasComposerRecovery(in: scope), "Draft writes do not recreate consumed recovery")
#if DEBUG
        XCTAssertEqual(observations.map(\.accepted), [true, true, true, true])
#endif
    }
}

extension ConversationDraftsTests {
    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Assistant-Test-Case": testCaseID]
        let session = URLSession(configuration: configuration)
        sessionLock.withLock { testSessions.append(session) }
        return APIClient(configuration: .init(baseURL: URL(string: "https://assistant.test")!, token: "test-token"),
            session: session)
    }

    private func bootstrap(owner: String = "owner") throws -> Data {
        try JSONEncoder().encode(BootstrapResponse(generatedAt: "2026-10-03T00:00:00Z",
            identity: .init(id: owner, name: "Ada", avatarUrl: nil),
            shell: .init(dashboard: .init(pendingApprovals: 0, needsAttention: 0, presence: .idle),
                memoryHealth: .init(totalUsable: 0, notYetOrganized: 0, awaitingReview: 0, ownerConfirmed: 0, lastOrganizedAt: nil)),
            conversation: .init(conversation: .init(id: "primary", title: "Main", modelOverride: nil,
                archivedAt: nil, isPrimary: true), agentName: "Ada", agentTimezone: "UTC", messages: [],
                models: [], goalTitle: nil, canArchive: false, cursor: nil, asyncTurn: nil)))
    }

    /// Each case owns its defaults and an in-memory credential sink. None of
    /// these pairing regressions reads or writes an owner's saved credentials.
    @MainActor
    private func pairedModel(tokenWriter: @escaping (String) throws -> Void = { _ in }) async throws -> (AppModel, UserDefaults, String) {
        let suite = "assistant.tests.pairing.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.set("https://assistant.test", forKey: "assistant.server-url")
        defaults.set(true, forKey: "assistant.push-prompted")
        let model = AppModel(apiClient: client(), defaults: defaults, storeConnectionToken: tokenWriter)
        model.scenePhaseDidChange(.background)
        StubURLProtocol.primeBootstrap(try bootstrap())
        await model.refreshAll(reportFailure: false)
        XCTAssertNotNil(model.bootstrap)
        return (model, defaults, suite)
    }

    @MainActor
    func testFailedPairingKeepsWorkingOwnerDraftAndSavedConnection() async throws {
        var writes = 0
        let (model, defaults, suite) = try await pairedModel { _ in writes += 1 }
        defer { defaults.removePersistentDomain(forName: suite) }
        let scope = try XCTUnwrap(model.composerDraftScope)
        model.saveComposerDraft("Stay in this account", in: scope)
        StubURLProtocol.prime([.success(status: 401, body: Data(#"{"error":"Invalid key"}"#.utf8))])
        let saved = await model.saveConnection(serverURL: "https://candidate.test", token: "candidate-token")
        XCTAssertFalse(saved)
        XCTAssertEqual(writes, 0)
        XCTAssertEqual(model.bootstrap?.identity.id, "owner")
        XCTAssertEqual(model.serverURL, "https://assistant.test")
        XCTAssertEqual(defaults.string(forKey: "assistant.server-url"), "https://assistant.test")
        XCTAssertEqual(model.composerDraftScope, scope)
        XCTAssertEqual(model.composerDraft(in: scope), "Stay in this account")
        XCTAssertEqual(StubURLProtocol.urls.first?.host, "candidate.test")
    }

    @MainActor
    func testVerifiedSameConnectionKeepsDraftSession() async throws {
        let (model, defaults, suite) = try await pairedModel()
        defer { defaults.removePersistentDomain(forName: suite) }
        let scope = try XCTUnwrap(model.composerDraftScope)
        model.saveComposerDraft("Keep this draft", in: scope)
        StubURLProtocol.prime([.success(status: 200, body: try bootstrap()), .success(status: 401, body: Data()),
            .success(status: 200, body: Data(#"{"ok":true}"#.utf8))])
        let saved = await model.saveConnection(serverURL: "https://assistant.test/", token: "test-token")
        XCTAssertTrue(saved, "A supplementary overview failure must not reject verified pairing")
        XCTAssertEqual(model.composerDraftScope, scope)
        XCTAssertEqual(model.composerDraft(in: scope), "Keep this draft")
    }

    @MainActor
    func testVerifiedNewOwnerClearsPrivateDraftsEvenWithTheSameConversationID() async throws {
        let (model, defaults, suite) = try await pairedModel()
        defer { defaults.removePersistentDomain(forName: suite) }
        let scope = try XCTUnwrap(model.composerDraftScope)
        model.saveComposerDraft("Old owner text", in: scope)
        StubURLProtocol.prime([.success(status: 200, body: try bootstrap(owner: "new-owner")),
            .success(status: 401, body: Data()), .success(status: 200, body: Data(#"{"ok":true}"#.utf8))])
        let saved = await model.saveConnection(serverURL: "https://candidate.test", token: "candidate-token")
        XCTAssertTrue(saved)
        let current = try XCTUnwrap(model.composerDraftScope)
        XCTAssertNotEqual(current.session, scope.session)
        XCTAssertEqual(model.bootstrap?.identity.id, "new-owner")
        XCTAssertEqual(model.composerDraft(in: current), "")
        model.saveComposerDraft("Late old view", in: scope)
        XCTAssertEqual(model.composerDraft(in: current), "")
    }

    @MainActor
    func testCancelledConnectClearsItsOwnLoadingIndicator() async throws {
        let (model, defaults, suite) = try await pairedModel()
        defer { defaults.removePersistentDomain(forName: suite) }
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/bootstrap": [.delayed(after: 0.2, status: 200, body: try bootstrap())],
            "/api/mobile/v1/overview": [.success(status: 401, body: Data())],
        ])
        let connect = Task { await model.connect() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while StubURLProtocol.attempts.isEmpty, ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(model.isLoading)
        connect.cancel()
        await connect.value
        XCTAssertFalse(model.isLoading)
        XCTAssertEqual(model.bootstrap?.identity.id, "owner")
    }

    @MainActor
    func testOldConnectionReadCannotPublishIntoNewOwner() async throws {
        let (model, defaults, suite) = try await pairedModel()
        defer { defaults.removePersistentDomain(forName: suite) }
        let old = McpConnectionsResponse(connections: [.init(id: "old-tool", name: "Old private tools",
            endpoint: "https://old-tools.test", status: "ready", enabled: true, hasBearerToken: false,
            serverName: nil, serverVersion: nil, instructions: nil, tools: [], lastCheckedAt: nil, lastError: nil)])
        StubURLProtocol.prime([.delayed(after: 0.2, status: 200, body: try JSONEncoder().encode(old))])
        let refresh = Task { await model.refreshMcpConnections() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while StubURLProtocol.attempts.isEmpty, ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertEqual(StubURLProtocol.urls.first?.path, "/api/mobile/v1/mcp")
        StubURLProtocol.prime([.success(status: 200, body: try bootstrap(owner: "new-owner")),
            .success(status: 401, body: Data()), .success(status: 200, body: Data(#"{"ok":true}"#.utf8))])
        let saved = await model.saveConnection(serverURL: "https://candidate.test", token: "candidate-token")
        XCTAssertTrue(saved)
        let published = await refresh.value
        XCTAssertFalse(published)
        XCTAssertEqual(model.bootstrap?.identity.id, "new-owner")
        XCTAssertTrue(model.mcpConnections.isEmpty, "A delayed old account read must not populate the new owner's tools")
    }
}
