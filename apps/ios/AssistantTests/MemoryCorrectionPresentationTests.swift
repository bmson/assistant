import XCTest
@testable import Assistant

final class MemoryCorrectionPresentationTests: XCTestCase {
    private func snapshot(
        owner: String = "owner-a", server: String = "server-a", memory: String = "note-a",
        revision: String = "r1", content: String = "Original saved note",
        availability: MemoryCorrectionSnapshotAvailability = .mayRequestAuthorization
    ) -> MemoryCorrectionSnapshot {
        .init(target: .init(ownerID: owner, serverID: server, memoryID: memory, sourceIdentity: "source-a"),
              revision: revision, storedContentHash: "stored-\(revision)", content: content,
              sourceLabel: "Fictional source", availability: availability)
    }

    private func request(_ state: inout MemoryCorrectionPresentation) throws -> MemoryCorrectionAuthorizationRequest {
        guard case .requestAuthorization(let request) = state.requestSave() else {
            throw NSError(domain: "Fixture expected local authorization request", code: 1)
        }
        return request
    }

    private func refreshRequest(_ state: inout MemoryCorrectionPresentation) throws -> MemoryCorrectionReadRequest {
        guard case .refreshSavedNote(let request) = state.requestRefresh() else {
            throw NSError(domain: "Fixture expected read request", code: 2)
        }
        return request
    }

    private func authorize(_ state: inout MemoryCorrectionPresentation, id: String = "server-issued-a") throws -> MemoryCorrectionOperation {
        let request = try request(&state)
        let operation = MemoryCorrectionOperation(operationID: id, target: request.snapshot.target,
            expectedRevision: request.snapshot.revision, expectedStoredContentHash: request.snapshot.storedContentHash)
        XCTAssertEqual(state.receiveAuthorization(for: request, result: .authorized(operation)),
                       .submit(operation, draft: request.draft))
        return operation
    }

    func testSaveRequestsAuthorizationBeforeAnyServerOperationExists() throws {
        var state = MemoryCorrectionPresentation(snapshot: snapshot())
        state.editDraft("Owner correction")
        let request = try request(&state)
        XCTAssertEqual(request.snapshot, snapshot())
        XCTAssertEqual(request.draft, "Owner correction")
        XCTAssertNil(state.operation)
        XCTAssertEqual(state.phase, .authorizing)
        XCTAssertNil(state.requestSave())
    }

    func testReadOnlyMismatchSnapshotCannotRequestAuthorizationOrRepairStoredHash() {
        let value = snapshot(content: "Displayed text need not hash to stored identity",
                             availability: .readOnly(reason: "This note could not be verified for editing."))
        var state = MemoryCorrectionPresentation(snapshot: value)
        state.editDraft("Kept local draft")
        XCTAssertFalse(state.canRequestAuthorization)
        XCTAssertNil(state.requestSave())
        XCTAssertEqual(state.reviewedSnapshot.storedContentHash, value.storedContentHash)
        XCTAssertEqual(state.draft, "Kept local draft")
        XCTAssertNotNil(state.statusText)
    }

    func testQueueAcceptanceDoesNotConfirmSaveAndFrozenDraftCannotChange() throws {
        var state = MemoryCorrectionPresentation(snapshot: snapshot())
        state.editDraft("Submitted correction")
        let operation = try authorize(&state)
        state.receiveQueueAcceptance(for: operation)
        state.editDraft("A later edit must not replace the submitted body")
        XCTAssertEqual(state.phase, .submitting)
        XCTAssertEqual(state.draft, "Submitted correction")
        XCTAssertEqual(state.statusText, "Saving…")
        XCTAssertNil(state.requestSave())
    }

    func testUnknownChecksOriginalOperationWithoutNewAuthorizationOrMutationBody() throws {
        var state = MemoryCorrectionPresentation(snapshot: snapshot())
        let operation = try authorize(&state)
        let request = state.authorizationRequest
        XCTAssertTrue(state.receiveOutcome(presentationID: state.presentationID, operation: operation,
                                          version: 1, disposition: .uncertain))
        XCTAssertEqual(state.checkResult(), .checkResult(operation))
        XCTAssertNil(state.checkResult())
        XCTAssertNil(state.requestSave())
        XCTAssertEqual(state.authorizationRequest, request)
        XCTAssertTrue(state.receiveOutcome(presentationID: state.presentationID, operation: operation,
                                          version: 1, disposition: .uncertain))
        XCTAssertTrue(state.canCheckResult, "An unchanged pending status permits another explicit check")
        XCTAssertEqual(state.close(), .close)
        XCTAssertEqual(state.operation, operation)
        XCTAssertEqual(state.draft, snapshot().content)
    }

    func testReadRefreshDoesNotResolveUnknownOrSilentlyRebaseDraft() throws {
        var state = MemoryCorrectionPresentation(snapshot: snapshot())
        state.editDraft("My kept correction")
        let operation = try authorize(&state)
        state.receiveOutcome(presentationID: state.presentationID, operation: operation, version: 1, disposition: .uncertain)
        let newer = snapshot(revision: "r2", content: "Newer saved text")
        let readRequest = try refreshRequest(&state)
        XCTAssertTrue(state.receiveCurrentSnapshot(for: readRequest, snapshot: newer))
        state.reviewCurrentKeepingDraft()
        XCTAssertEqual(state.phase, .unknown)
        XCTAssertEqual(state.reviewedSnapshot, snapshot())
        XCTAssertEqual(state.currentSnapshot, newer)
        XCTAssertEqual(state.draft, "My kept correction")
        XCTAssertEqual(state.checkResult(), .checkResult(operation))
    }

    func testStaleNoWriteRequiresExplicitReviewThenNewAuthorization() throws {
        var state = MemoryCorrectionPresentation(snapshot: snapshot())
        state.editDraft("My kept correction")
        let operation = try authorize(&state)
        let newer = snapshot(revision: "r2", content: "Newer saved text")
        state.receiveOutcome(presentationID: state.presentationID, operation: operation, version: 1,
                             disposition: .staleNoWrite(newer))
        XCTAssertNil(state.requestSave())
        state.reviewCurrentKeepingDraft()
        XCTAssertNil(state.operation)
        XCTAssertEqual(state.openedSnapshot, snapshot())
        let next = try request(&state)
        XCTAssertEqual(next.snapshot, newer)
        XCTAssertEqual(next.draft, "My kept correction")
        XCTAssertEqual(state.phase, .authorizing)
    }

    func testLateAAndOtherOwnerOrServerCannotChangeB() throws {
        var a = MemoryCorrectionPresentation(snapshot: snapshot())
        let operationA = try authorize(&a)
        let requestA = try XCTUnwrap(a.authorizationRequest)
        a.receiveOutcome(presentationID: a.presentationID, operation: operationA, version: 1, disposition: .uncertain)
        let readA = try refreshRequest(&a)
        for value in [snapshot(memory: "note-b"), snapshot(owner: "owner-b"), snapshot(server: "server-b"), snapshot()] {
            var b = MemoryCorrectionPresentation(snapshot: value)
            b.editDraft("B draft stays here")
            let operationB = try authorize(&b, id: "server-issued-b")
            let baseline = b
            XCTAssertNil(b.receiveAuthorization(for: requestA, result: .authorized(operationA)))
            XCTAssertFalse(b.receiveOutcome(presentationID: a.presentationID, operation: operationA,
                                            version: 99, disposition: .saved(readback: nil)))
            b.checkFailed(presentationID: a.presentationID, operation: operationA)
            XCTAssertFalse(b.receiveCurrentSnapshot(for: readA, snapshot: snapshot()))
            XCTAssertEqual(b, baseline)
            XCTAssertEqual(b.operation, operationB)
        }
    }

    func testWrongTargetAuthorizationAndReadbackAreNotAccepted() throws {
        var state = MemoryCorrectionPresentation(snapshot: snapshot())
        let request = try request(&state)
        let foreign = MemoryCorrectionOperation(operationID: "foreign", target: snapshot(memory: "other").target,
            expectedRevision: "r1", expectedStoredContentHash: "stored-r1")
        XCTAssertNil(state.receiveAuthorization(for: request, result: .authorized(foreign)))
        XCTAssertNil(state.operation)
        let correct = MemoryCorrectionOperation(operationID: "correct", target: request.snapshot.target,
            expectedRevision: "r1", expectedStoredContentHash: request.snapshot.storedContentHash)
        _ = state.receiveAuthorization(for: request, result: .authorized(correct))
        XCTAssertFalse(state.receiveOutcome(presentationID: state.presentationID, operation: correct,
            version: 1, disposition: .saved(readback: snapshot(memory: "other"))))
        XCTAssertEqual(state.phase, .submitting)
    }

    func testConfirmedReceiptAndReadbackRemainSeparateAndTerminalDoesNotRegress() throws {
        var state = MemoryCorrectionPresentation(snapshot: snapshot())
        let operation = try authorize(&state)
        state.receiveOutcome(presentationID: state.presentationID, operation: operation,
                             version: 2, disposition: .saved(readback: nil))
        XCTAssertEqual(state.phase, .saved)
        XCTAssertNil(state.currentSnapshot)
        XCTAssertTrue(state.statusText?.contains("not been refreshed") == true)
        XCTAssertFalse(state.receiveOutcome(presentationID: state.presentationID, operation: operation,
                                            version: 3, disposition: .uncertain))
        let saved = snapshot(revision: "r2", content: "Confirmed saved correction")
        let readRequest = try refreshRequest(&state)
        XCTAssertTrue(state.receiveCurrentSnapshot(for: readRequest, snapshot: saved))
        XCTAssertEqual(state.currentSnapshot, saved)
        XCTAssertNil(state.resultReadback, "A generic successful read does not prove operation readback")
        let boundReadRequest = try refreshRequest(&state)
        XCTAssertTrue(state.receiveConfirmedReadback(for: boundReadRequest, snapshot: saved))
        XCTAssertEqual(state.statusText, "Saved.")
    }

    func testLateReadFromAAfterNewOperationBCannotReplaceCurrentText() throws {
        var state = MemoryCorrectionPresentation(snapshot: snapshot())
        let a = try authorize(&state)
        state.receiveOutcome(presentationID: state.presentationID, operation: a, version: 1, disposition: .uncertain)
        let lateRead = try refreshRequest(&state)
        let current = snapshot(revision: "r2", content: "Current saved information")
        state.receiveOutcome(presentationID: state.presentationID, operation: a, version: 2, disposition: .staleNoWrite(current))
        state.reviewCurrentKeepingDraft()
        let b = try authorize(&state, id: "server-issued-b")
        state.receiveOutcome(presentationID: state.presentationID, operation: b, version: 1, disposition: .uncertain)
        let baseline = state
        XCTAssertFalse(state.receiveCurrentSnapshot(for: lateRead, snapshot: snapshot()))
        XCTAssertEqual(state, baseline)
    }

    func testSavedWithoutReadbackKeepsLastKnownCurrentText() throws {
        var state = MemoryCorrectionPresentation(snapshot: snapshot())
        let a = try authorize(&state)
        let current = snapshot(revision: "r2", content: "Last known current saved note")
        state.receiveOutcome(presentationID: state.presentationID, operation: a, version: 1, disposition: .staleNoWrite(current))
        state.reviewCurrentKeepingDraft()
        let b = try authorize(&state, id: "server-issued-b")
        state.receiveOutcome(presentationID: state.presentationID, operation: b, version: 1, disposition: .saved(readback: nil))
        XCTAssertEqual(state.currentSnapshot, current)
        XCTAssertNil(state.resultReadback)
        XCTAssertTrue(state.statusText?.contains("not been refreshed") == true)
    }

    func testCancelBeforeDispatchInvalidatesLateAuthorizationWithoutSubmitting() throws {
        var state = MemoryCorrectionPresentation(snapshot: snapshot())
        let request = try request(&state)
        XCTAssertEqual(state.cancelBeforeDispatch(), .close)
        let operation = MemoryCorrectionOperation(operationID: "late-server-operation", target: request.snapshot.target,
            expectedRevision: "r1", expectedStoredContentHash: request.snapshot.storedContentHash)
        XCTAssertNil(state.receiveAuthorization(for: request, result: .authorized(operation)))
        XCTAssertEqual(state.phase, .cancelled)
        XCTAssertEqual(state.draft, "")
        XCTAssertNil(state.operation)
    }
}
