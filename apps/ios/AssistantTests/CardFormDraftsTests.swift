import Foundation
import XCTest
@testable import Assistant

final class CardFormDraftsTests: XCTestCase {
    func testDraftSurvivesRemountAndFieldReorderByStableID() async throws {
        let storage = MemoryCardFormStorage()
        let first = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationA })
        let scope = Self.scope
        let original = Self.form(revision: Self.revisionA)
        _ = try await first.open(scope: scope, form: original)
        _ = try await first.setValue(.text("Ada"), fieldId: "name", scope: scope, form: original)
        _ = try await first.setValue(.choice("early"), fieldId: "time", scope: scope, form: original)
        _ = try await first.setValue(.date("2026-10-08"), fieldId: "day", scope: scope, form: original)
        _ = try await first.setValue(.boolean(false), fieldId: "remind", scope: scope, form: original)

        let reordered = Self.form(revision: Self.revisionA, fields: Array(original.fields.reversed()))
        let remounted = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationB })
        let loaded = try await remounted.open(scope: scope, form: reordered)
        XCTAssertEqual(loaded.values["name"], .text("Ada"))
        XCTAssertEqual(loaded.values["time"], .choice("early"))
        XCTAssertEqual(loaded.values["day"], .date("2026-10-08"))
        XCTAssertEqual(loaded.values["remind"], .boolean(false))
        XCTAssertNil(loaded.pendingReview)
        XCTAssertEqual(loaded.phase, .idle)
        XCTAssertNil(loaded.frozenSubmission, "Prefilling/editing form fields alone does not create an admission")
    }

    func testConcurrentFieldEditsQueueAndPersistInsteadOfDroppingKeystrokes() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage)
        let form = Self.form(revision: Self.revisionA)
        _ = try await coordinator.open(scope: Self.scope, form: form)
        async let name: CardFormDraft = coordinator.setValue(.text("Ada Lovelace"), fieldId: "name", scope: Self.scope, form: form)
        async let time: CardFormDraft = coordinator.setValue(.choice("late"), fieldId: "time", scope: Self.scope, form: form)
        _ = try await (name, time)
        let loaded = try await storage.load(scope: Self.scope)
        let saved = try XCTUnwrap(loaded)
        XCTAssertEqual(saved.values["name"], .text("Ada Lovelace"))
        XCTAssertEqual(saved.values["time"], .choice("late"))
    }

    func testLocalEncodingPreservesFieldKindsWhileWireValuesArePrimitive() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationA })
        let form = Self.form(revision: Self.revisionA)
        _ = try await coordinator.open(scope: Self.scope, form: form)
        _ = try await coordinator.setValue(.text(" Ada "), fieldId: "name", scope: Self.scope, form: form)
        _ = try await coordinator.setValue(.choice("early"), fieldId: "time", scope: Self.scope, form: form)
        _ = try await coordinator.setValue(.date("2026-10-08"), fieldId: "day", scope: Self.scope, form: form)
        _ = try await coordinator.setValue(.boolean(false), fieldId: "remind", scope: Self.scope, form: form)

        let loadedDraft = try await storage.load(scope: Self.scope)
        let draft = try XCTUnwrap(loadedDraft)
        let encodedDraft = try JSONEncoder().encode(draft)
        let decodedDraft = try JSONDecoder().decode(CardFormDraft.self, from: encodedDraft)
        XCTAssertEqual(decodedDraft.values["time"], .choice("early"))
        XCTAssertEqual(decodedDraft.values["day"], .date("2026-10-08"))
        XCTAssertEqual(decodedDraft.values["remind"], .boolean(false))

        let request = try await submit(coordinator, form: form)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body) as? [String: Any])
        XCTAssertEqual(Set(json.keys), Set(["protocol", "conversationId", "cardId", "expectedRevisionId", "formId", "operationId", "values", "ownerMessageText"]))
        XCTAssertEqual(json["protocol"] as? String, "card-form-v1")
        XCTAssertEqual(json["ownerMessageText"] as? String, "Please help with this saved-card request.")
        XCTAssertNil(json["ownerId"], "Authenticated owner identity is server-derived")
        let values = try XCTUnwrap(json["values"] as? [String: Any])
        XCTAssertEqual(values["name"] as? String, "Ada", "Text is trimmed before freezing the request")
        XCTAssertEqual(values["time"] as? String, "early")
        XCTAssertEqual(values["day"] as? String, "2026-10-08")
        XCTAssertEqual(values["remind"] as? Bool, false, "False is a present boolean value")
    }

    func testSendFreezesTrimmedOwnerComposerTextAndNormalizesUUIDs() async throws {
        let storage = MemoryCardFormStorage()
        let upperConversationId = "ABCDEFAB-CDEF-4000-8000-ABCDEFABCDEF"
        let upperCardId = "ABCDEFAB-CDEF-4000-8000-ABCDEFABCDE1"
        let upperRevisionId = "ABCDEFAB-CDEF-4000-8000-ABCDEFABCDE2"
        let uppercaseOperationId = "ABCDEFAB-CDEF-4000-8000-ABCDEFABCDE3"
        let scope = CardFormScope(
            ownerId: Self.scope.ownerId,
            sessionId: Self.scope.sessionId,
            conversationId: upperConversationId,
            cardId: upperCardId,
            formId: Self.scope.formId
        )
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { uppercaseOperationId })
        let form = Self.form(revision: upperRevisionId, cardId: upperCardId)
        _ = try await coordinator.open(scope: scope, form: form)
        _ = try await coordinator.setValue(.text("Ada"), fieldId: "name", scope: scope, form: form)
        _ = try await coordinator.setValue(.choice("early"), fieldId: "time", scope: scope, form: form)
        _ = try await coordinator.setValue(.date("2026-10-08"), fieldId: "day", scope: scope, form: form)
        let request = try await submit(
            coordinator,
            scope: scope,
            form: form,
            ownerMessageText: "  Please draft the plan and leave the invitation unsent.  "
        )
        XCTAssertEqual(request.submission.conversationId, upperConversationId.lowercased())
        XCTAssertEqual(request.submission.cardId, upperCardId.lowercased())
        XCTAssertEqual(request.submission.expectedRevisionId, upperRevisionId.lowercased())
        XCTAssertEqual(request.submission.operationId, uppercaseOperationId.lowercased())
        XCTAssertEqual(request.submission.ownerMessageText, "Please draft the plan and leave the invitation unsent.")

        let stillPending = try await coordinator.open(scope: scope, form: form)
        XCTAssertEqual(stillPending.phase, .submitting, "In-flight identity uses the normalized operation ID")
        XCTAssertEqual(stillPending.frozenRequestBody, request.body)
    }

    func testOwnerComposerMessageIsRequiredAndLimitedToFourThousandUTF16Units() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationA })
        let form = Self.form(revision: Self.revisionA)
        try await fillRequiredValues(coordinator, form: form)
        let exactLimit = String(repeating: "😀", count: 2_000)
        let request = try await submit(coordinator, form: form, ownerMessageText: exactLimit)
        XCTAssertEqual(request.submission.ownerMessageText.utf16.count, 4_000)
        XCTAssertEqual(request.submission.ownerMessageText, exactLimit)

        let otherStorage = MemoryCardFormStorage()
        let other = CardFormDraftCoordinator(storage: otherStorage, makeOperationId: { Self.operationB })
        try await fillRequiredValues(other, form: form)
        do {
            _ = try await submit(other, form: form, ownerMessageText: String(repeating: "😀", count: 2_001))
            XCTFail("The owner message follows the server's 4000 UTF-16-unit limit")
        } catch CardFormDraftError.invalidOwnerMessage {}
        do {
            _ = try await submit(other, form: form, ownerMessageText: " \n \t")
            XCTFail("A blank owner composer cannot create an admission")
        } catch CardFormDraftError.invalidOwnerMessage {}
        let rejectedDraft = try await otherStorage.load(scope: Self.scope)
        XCTAssertNil(rejectedDraft?.frozenSubmission)
    }

    func testRevisionRequiresExplicitReviewAndCarriesOnlyCompatibleStableFields() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationA })
        let old = Self.form(revision: Self.revisionA)
        _ = try await coordinator.open(scope: Self.scope, form: old)
        _ = try await coordinator.setValue(.text("Ada"), fieldId: "name", scope: Self.scope, form: old)
        _ = try await coordinator.setValue(.choice("early"), fieldId: "time", scope: Self.scope, form: old)
        _ = try await coordinator.setValue(.date("2026-10-08"), fieldId: "day", scope: Self.scope, form: old)
        _ = try await coordinator.setValue(.boolean(false), fieldId: "remind", scope: Self.scope, form: old)

        let revised = Self.form(revision: Self.revisionB, fields: [
            old.fields[0],
            .init(id: "time", type: .text, label: "Preferred time", required: true),
            old.fields[2],
            .init(id: "notes", type: .text, label: "Notes", required: false),
        ])
        let awaiting = try await coordinator.open(scope: Self.scope, form: revised)
        XCTAssertEqual(awaiting.pendingReview?.revisionId, Self.revisionB)
        do {
            _ = try await submit(coordinator, form: revised)
            XCTFail("A changed card revision cannot submit old values before review")
        } catch CardFormDraftError.needsRevisionReview {}

        let reviewed = try await coordinator.reviewRevision(scope: Self.scope, form: revised, carryCompatibleValues: true)
        XCTAssertEqual(reviewed.viewedRevisionId, Self.revisionB)
        XCTAssertEqual(reviewed.values["name"], .text("Ada"))
        XCTAssertNil(reviewed.values["time"], "A value with the same ID but a different type is discarded")
        XCTAssertEqual(reviewed.values["day"], .date("2026-10-08"))
        XCTAssertNil(reviewed.values["remind"], "Removed fields are not carried into the new schema")
        XCTAssertNil(reviewed.values["notes"])

        let discarded = try await coordinator.reviewRevision(
            scope: Self.scope,
            form: Self.form(revision: Self.revisionC),
            carryCompatibleValues: false
        )
        XCTAssertEqual(discarded.values, [:])
        XCTAssertEqual(discarded.viewedRevisionId, Self.revisionC)
    }

    func testUnknownOutcomeReopensAsSameFrozenOperationAndBlocksSecondSubmit() async throws {
        let storage = MemoryCardFormStorage()
        let form = Self.form(revision: Self.revisionA)
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationA })
        try await fillRequiredValues(coordinator, form: form)
        let first = try await submit(
            coordinator,
            form: form,
            ownerMessageText: "  Please check the early appointment, but do not book it yet.  "
        )
        XCTAssertEqual(first.submission.ownerMessageText, "Please check the early appointment, but do not book it yet.")
        let stillPendingInCurrentCoordinator = try await coordinator.open(scope: Self.scope, form: form)
        XCTAssertEqual(stillPendingInCurrentCoordinator.phase, .submitting)
        do {
            _ = try await coordinator.retryUnknown(scope: Self.scope)
            XCTFail("A mounted coordinator must not retry while its request is still in flight")
        } catch CardFormDraftError.submissionPending {}
        XCTAssertEqual(first.submission.operationId, Self.operationA)
        XCTAssertEqual(first.submission.protocolVersion, "card-form-v1")
        XCTAssertEqual(first.submission.expectedRevisionId, Self.revisionA)
        XCTAssertEqual(first.submission.values["time"], .string("early"))

        do {
            _ = try await submit(coordinator, form: form)
            XCTFail("A second tap cannot create an operation while one is unresolved")
        } catch CardFormDraftError.submissionPending {}

        let recordedUnknown = try await coordinator.recordOutcome(
            .init(operationId: first.submission.operationId, outcome: .outcomeUnknown), scope: Self.scope
        )
        XCTAssertTrue(recordedUnknown)
        let remounted = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationB })
        let reopened = try await remounted.open(scope: Self.scope, form: form)
        XCTAssertEqual(reopened.phase, .outcomeUnknown)
        let retry = try await remounted.retryUnknown(scope: Self.scope)
        XCTAssertEqual(retry, first, "Retry reuses the exact frozen body and operation ID")
        XCTAssertEqual(retry.body, first.body, "The persisted request bytes are reused unchanged")

        let receipt = CardFormAdmissionReceipt(
            taskId: Self.taskA,
            messageId: Self.messageA,
            taskStatus: "pending",
            queueGeneration: 7,
            created: true,
            dispatch: .outbox
        )
        let recordedAccepted = try await remounted.recordOutcome(
            .init(operationId: retry.submission.operationId, outcome: .accepted(receipt)), scope: Self.scope
        )
        XCTAssertTrue(recordedAccepted)
        let settled = try await remounted.open(scope: Self.scope, form: form)
        XCTAssertEqual(settled.phase, .accepted(receipt))
        XCTAssertNil(settled.frozenRequestBody, "A durable receipt releases the private retry body")
        do {
            _ = try await submit(remounted, form: form)
            XCTFail("An acknowledged operation cannot be submitted again from its old draft")
        } catch CardFormDraftError.submissionAlreadySettled {}
    }


    func testStartupRecoveryFencesPersistedSubmittingOperationBeforeOrdinarySend() async throws {
        let storage = MemoryCardFormStorage()
        let form = Self.form(revision: Self.revisionA)
        let original = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationA })
        try await fillRequiredValues(original, form: form)
        let frozen = try await submit(original, form: form)

        let restarted = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationB })
        let restored = try await restarted.restoreUnsettled(ownerId: Self.scope.ownerId, sessionId: Self.scope.sessionId)
        XCTAssertEqual(restored.count, 1)
        XCTAssertEqual(restored[0].phase, .outcomeUnknown)
        XCTAssertEqual(restored[0].frozenSubmission?.operationId, frozen.submission.operationId)
        XCTAssertEqual(restored[0].frozenRequestBody, frozen.body)
    }

    func testActiveFormPointerIsNotAdmissionAndUnlocksOnlyAfterThatTaskIsTerminal() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationA })
        let form = Self.form(revision: Self.revisionA)
        try await fillRequiredValues(coordinator, form: form)
        let pending = try await submit(coordinator, form: form)
        let pointer = CardFormActiveTaskPointer(taskId: Self.taskA, taskStatus: "waiting_approval")
        _ = try await coordinator.recordOutcome(
            .init(operationId: pending.submission.operationId, outcome: .activeForm(pointer)), scope: Self.scope
        )
        let stored = try await coordinator.open(scope: Self.scope, form: form)
        XCTAssertEqual(stored.phase, .activeForm(pointer))
        XCTAssertEqual(stored.frozenRequestBody, pending.body, "The exact unsent operation stays available for explicit retry after the active task ends")
        do {
            _ = try await coordinator.startNextEntryAfterTerminal(
                scope: Self.scope, taskId: Self.taskA, observedTaskStatus: "waiting_approval"
            )
            XCTFail("An active task cannot unlock another form entry")
        } catch CardFormDraftError.taskNotTerminal {}
        let next = try await coordinator.startNextEntryAfterTerminal(
            scope: Self.scope, taskId: Self.taskA, observedTaskStatus: "done"
        )
        XCTAssertEqual(next.phase, .idle)
        XCTAssertNil(next.frozenSubmission)
    }

    func testActiveFormPointerCannotBeDowngradedByLateUnknownOrAcceptedResponse() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationA })
        let form = Self.form(revision: Self.revisionA)
        try await fillRequiredValues(coordinator, form: form)
        let request = try await submit(coordinator, form: form)
        let active = CardFormActiveTaskPointer(taskId: Self.taskA, taskStatus: "waiting_approval")
        _ = try await coordinator.recordOutcome(
            .init(operationId: request.submission.operationId, outcome: .activeForm(active)), scope: Self.scope
        )

        let lateUnknown = try await coordinator.recordOutcome(
            .init(operationId: request.submission.operationId, outcome: .outcomeUnknown), scope: Self.scope
        )
        XCTAssertFalse(lateUnknown)
        let falseAdmission = CardFormAdmissionReceipt(
            taskId: Self.taskB, messageId: "00000000-0000-4000-8000-000000000011", taskStatus: "pending",
            queueGeneration: 8, created: true, dispatch: .notify
        )
        let lateAccepted = try await coordinator.recordOutcome(
            .init(operationId: request.submission.operationId, outcome: .accepted(falseAdmission)), scope: Self.scope
        )
        XCTAssertFalse(lateAccepted)

        let durable = try await storage.load(scope: Self.scope)
        XCTAssertEqual(durable?.phase, .activeForm(active))
        XCTAssertEqual(durable?.frozenRequestBody, request.body)
    }

    func testCrashAfterFrozenWriteMakesPersistedSubmittingRetryableWithSameBytes() async throws {
        let storage = MemoryCardFormStorage()
        let form = Self.form(revision: Self.revisionA)
        let original = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationA })
        try await fillRequiredValues(original, form: form)
        let frozen = try await submit(original, form: form)

        let restarted = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationB })
        let recovered = try await restarted.open(scope: Self.scope, form: form)
        XCTAssertEqual(recovered.phase, .outcomeUnknown)
        let retry = try await restarted.retryUnknown(scope: Self.scope)
        XCTAssertEqual(retry.submission.operationId, frozen.submission.operationId)
        XCTAssertEqual(retry.body, frozen.body)
    }

    func testAcceptedReceiptIsMonotonicAgainstLateFailureOrUnknownResponse() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationA })
        let form = Self.form(revision: Self.revisionA)
        try await fillRequiredValues(coordinator, form: form)
        let request = try await submit(coordinator, form: form)
        let receipt = CardFormAdmissionReceipt(
            taskId: Self.taskA, messageId: Self.messageA, taskStatus: "pending", queueGeneration: 3,
            created: true, dispatch: .notify
        )
        let accepted = try await coordinator.recordOutcome(
            .init(operationId: request.submission.operationId, outcome: .accepted(receipt)), scope: Self.scope
        )
        XCTAssertTrue(accepted)
        let lateUnknown = try await coordinator.recordOutcome(
            .init(operationId: request.submission.operationId, outcome: .outcomeUnknown), scope: Self.scope
        )
        XCTAssertFalse(lateUnknown)
        let lateFailure = try await coordinator.recordOutcome(
            .init(operationId: request.submission.operationId, outcome: .rejected(status: 503, code: "late_failure")),
            scope: Self.scope
        )
        XCTAssertFalse(lateFailure)
        let current = try await coordinator.open(scope: Self.scope, form: form)
        XCTAssertEqual(current.phase, .accepted(receipt))
    }

    func testNewOperationRequiresExactAcceptedTaskToBecomeTerminal() async throws {
        let storage = MemoryCardFormStorage()
        let ids = LockedIds([Self.operationA, Self.operationB])
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { ids.next() })
        let form = Self.form(revision: Self.revisionA)
        try await fillRequiredValues(coordinator, form: form)
        let first = try await submit(coordinator, form: form)
        let receipt = CardFormAdmissionReceipt(
            taskId: Self.taskA, messageId: Self.messageA, taskStatus: "pending", queueGeneration: 1,
            created: true, dispatch: .outbox
        )
        _ = try await coordinator.recordOutcome(
            .init(operationId: first.submission.operationId, outcome: .accepted(receipt)), scope: Self.scope
        )
        do {
            _ = try await coordinator.startNextEntryAfterTerminal(
                scope: Self.scope, taskId: Self.taskA, observedTaskStatus: "pending"
            )
            XCTFail("An admission receipt does not mean the task is finished")
        } catch CardFormDraftError.taskNotTerminal {}
        do {
            _ = try await coordinator.startNextEntryAfterTerminal(
                scope: Self.scope, taskId: Self.taskB, observedTaskStatus: "done"
            )
            XCTFail("A terminal status for another task cannot unlock this form")
        } catch CardFormDraftError.submissionAlreadySettled {}

        let ready = try await coordinator.startNextEntryAfterTerminal(
            scope: Self.scope, taskId: Self.taskA, observedTaskStatus: "done"
        )
        XCTAssertEqual(ready.phase, .idle)
        XCTAssertNil(ready.frozenSubmission)
        XCTAssertNil(ready.values["name"], "A next explicit entry starts with fresh field values")
        XCTAssertNil(ready.values["remind"], "A fresh entry requires a new explicit Yes/No choice")
        _ = try await coordinator.setValue(.text("Grace"), fieldId: "name", scope: Self.scope, form: form)
        _ = try await coordinator.setValue(.choice("late"), fieldId: "time", scope: Self.scope, form: form)
        _ = try await coordinator.setValue(.date("2026-10-09"), fieldId: "day", scope: Self.scope, form: form)
        let second = try await submit(coordinator, form: form)
        XCTAssertEqual(second.submission.operationId, Self.operationB)
    }

    func testConcurrentSubmitCallsCreateAtMostOneFrozenOperation() async throws {
        let storage = MemoryCardFormStorage()
        let ids = LockedIds([Self.operationA, Self.operationB])
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { ids.next() })
        let form = Self.form(revision: Self.revisionA)
        try await fillRequiredValues(coordinator, form: form)

        let outcomes = await withTaskGroup(of: Result<CardFormPendingRequest, Error>.self) { group in
            group.addTask { await Self.submitResult(coordinator, form: form) }
            group.addTask { await Self.submitResult(coordinator, form: form) }
            var results: [Result<CardFormPendingRequest, Error>] = []
            for await result in group { results.append(result) }
            return results
        }
        XCTAssertEqual(outcomes.filter { (try? $0.get()) != nil }.count, 1)
        XCTAssertEqual(outcomes.filter {
            guard case let .failure(error) = $0 else { return false }
            return (error as? CardFormDraftError) == .submissionPending
        }.count, 1)
        let loadedStored = try await storage.load(scope: Self.scope)
        let stored = try XCTUnwrap(loadedStored)
        XCTAssertEqual(stored.phase, .submitting)
        XCTAssertEqual(stored.frozenSubmission?.operationId, Self.operationA)
        XCTAssertNotNil(stored.frozenRequestBody)
    }

    func testAcceptedPendingTaskStaysFencedAcrossRevisionReviewUntilExactTaskIsTerminal() async throws {
        let storage = MemoryCardFormStorage()
        let ids = LockedIds([Self.operationA, Self.operationB])
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { ids.next() })
        let old = Self.form(revision: Self.revisionA)
        try await fillRequiredValues(coordinator, form: old)
        let request = try await submit(coordinator, form: old)
        let receipt = CardFormAdmissionReceipt(
            taskId: Self.taskA, messageId: Self.messageA, taskStatus: "pending", queueGeneration: 4,
            created: true, dispatch: .notify
        )
        _ = try await coordinator.recordOutcome(
            .init(operationId: request.submission.operationId, outcome: .accepted(receipt)), scope: Self.scope
        )

        let revised = Self.form(revision: Self.revisionB)
        let awaiting = try await coordinator.open(scope: Self.scope, form: revised)
        XCTAssertEqual(awaiting.pendingReview?.revisionId, Self.revisionB)
        let reviewed = try await coordinator.reviewRevision(
            scope: Self.scope, form: revised, carryCompatibleValues: true
        )
        XCTAssertEqual(reviewed.phase, .accepted(receipt))
        XCTAssertEqual(reviewed.frozenSubmission, request.submission)
        do {
            _ = try await submit(coordinator, form: revised)
            XCTFail("Reviewing a new revision cannot create another operation while the accepted task is pending")
        } catch CardFormDraftError.submissionAlreadySettled {}
        for parkedStatus in ["waiting_approval", "waiting_budget", "needs_attention"] {
            do {
                _ = try await coordinator.startNextEntryAfterTerminal(
                    scope: Self.scope, taskId: Self.taskA, observedTaskStatus: parkedStatus
                )
                XCTFail("The accepted task remains fenced while it is \(parkedStatus)")
            } catch CardFormDraftError.taskNotTerminal {}
        }
        do {
            _ = try await coordinator.startNextEntryAfterTerminal(
                scope: Self.scope, taskId: Self.taskA, observedTaskStatus: "pending"
            )
            XCTFail("A reviewed revision does not make the accepted task terminal")
        } catch CardFormDraftError.taskNotTerminal {}

        let ready = try await coordinator.startNextEntryAfterTerminal(
            scope: Self.scope, taskId: Self.taskA, observedTaskStatus: "done"
        )
        XCTAssertEqual(ready.viewedRevisionId, Self.revisionB)
        XCTAssertEqual(ready.phase, .idle)
        _ = try await coordinator.setValue(.text("Grace"), fieldId: "name", scope: Self.scope, form: revised)
        _ = try await coordinator.setValue(.choice("early"), fieldId: "time", scope: Self.scope, form: revised)
        _ = try await coordinator.setValue(.date("2026-10-11"), fieldId: "day", scope: Self.scope, form: revised)
        let next = try await submit(
            coordinator,
            form: revised,
            ownerMessageText: "Please continue with the reviewed revision."
        )
        XCTAssertEqual(next.submission.operationId, Self.operationB)
        XCTAssertEqual(next.submission.expectedRevisionId, Self.revisionB)
        XCTAssertEqual(next.submission.ownerMessageText, "Please continue with the reviewed revision.")
    }

    func testSameRevisionCannotChangeFieldSemanticsButMayReorderFields() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage)
        let original = Self.form(revision: Self.revisionA)
        _ = try await coordinator.open(scope: Self.scope, form: original)
        let reordered = Self.form(revision: Self.revisionA, fields: Array(original.fields.reversed()))
        let acceptedReorder = try await coordinator.open(scope: Self.scope, form: reordered)
        XCTAssertEqual(acceptedReorder.viewedFields, reordered.fields)

        let mutated = Self.form(revision: Self.revisionA, fields: [
            original.fields[0],
            .init(id: "time", type: .text, label: "Preferred time", required: true),
            original.fields[2],
            original.fields[3],
        ])
        do {
            _ = try await coordinator.open(scope: Self.scope, form: mutated)
            XCTFail("A semantic form change must receive a new immutable revision")
        } catch CardFormDraftError.revisionDescriptorMismatch {}
        let persisted = try await storage.load(scope: Self.scope)
        XCTAssertEqual(try XCTUnwrap(persisted).viewedFields, reordered.fields)
    }

    func testCorruptStoredDuplicateFieldsFailClosedWithoutDictionaryTrap() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage)
        let form = Self.form(revision: Self.revisionA)
        let opened = try await coordinator.open(scope: Self.scope, form: form)
        var corrupt = opened
        corrupt.viewedFields = [form.fields[0], form.fields[0], form.fields[2], form.fields[3]]
        try await storage.save(corrupt)

        do {
            _ = try await coordinator.open(scope: Self.scope, form: form)
            XCTFail("Corrupt persisted duplicate IDs must fail closed instead of trapping")
        } catch CardFormDraftError.revisionDescriptorMismatch {}
    }

    func testStaleConflictCannotBeClearedByOldMountedRevision() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationA })
        let old = Self.form(revision: Self.revisionA)
        try await fillRequiredValues(coordinator, form: old)
        let submission = try await submit(coordinator, form: old)
        _ = try await coordinator.recordOutcome(
            .init(operationId: submission.submission.operationId, outcome: .rejected(status: 409, code: "stale_revision")),
            scope: Self.scope
        )

        let remountOfOldView = try await coordinator.open(scope: Self.scope, form: old)
        XCTAssertTrue(remountOfOldView.requiresFreshRevision)
        do {
            _ = try await coordinator.resumeEditingAfterRejection(scope: Self.scope)
            XCTFail("A stale conflict requires a newly fetched revision")
        } catch CardFormDraftError.submissionPending {}
        do {
            _ = try await submit(coordinator, form: old)
            XCTFail("Old revision must remain blocked")
        } catch CardFormDraftError.needsRevisionReview {}

        let latest = Self.form(revision: Self.revisionB)
        let review = try await coordinator.open(scope: Self.scope, form: latest)
        XCTAssertEqual(review.pendingReview?.revisionId, Self.revisionB)
        XCTAssertFalse(review.requiresFreshRevision)
        let afterExplicitDiscard = try await coordinator.reviewRevision(
            scope: Self.scope, form: latest, carryCompatibleValues: false
        )
        XCTAssertNil(afterExplicitDiscard.pendingReview)
        XCTAssertEqual(afterExplicitDiscard.values, [:])
        XCTAssertEqual(afterExplicitDiscard.phase, .idle)
    }

    func testLateReceiptCannotSettleANewerOperationAfterDefiniteRejection() async throws {
        let storage = MemoryCardFormStorage()
        let ids = LockedIds([Self.operationA, Self.operationB])
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { ids.next() })
        let form = Self.form(revision: Self.revisionA)
        try await fillRequiredValues(coordinator, form: form)
        let first = try await submit(coordinator, form: form)
        let recorded = try await coordinator.recordOutcome(
            .init(operationId: first.submission.operationId, outcome: .rejected(status: 422, code: "invalid_value")),
            scope: Self.scope
        )
        XCTAssertTrue(recorded)
        do {
            _ = try await coordinator.setValue(.text("Grace"), fieldId: "name", scope: Self.scope, form: form)
            XCTFail("Editing after rejection requires an explicit transition")
        } catch CardFormDraftError.submissionPending {}
        _ = try await coordinator.resumeEditingAfterRejection(scope: Self.scope)
        _ = try await coordinator.setValue(.text("Grace"), fieldId: "name", scope: Self.scope, form: form)
        let second = try await submit(
            coordinator,
            form: form,
            ownerMessageText: "Please choose the later time instead."
        )
        XCTAssertEqual(second.submission.operationId, Self.operationB)
        XCTAssertEqual(second.submission.ownerMessageText, "Please choose the later time instead.")

        let accepted = CardFormAdmissionReceipt(
            taskId: Self.taskA, messageId: Self.messageA, taskStatus: "pending", queueGeneration: 1,
            created: true, dispatch: .notify
        )
        let late = try await coordinator.recordOutcome(
            .init(operationId: first.submission.operationId, outcome: .accepted(accepted)), scope: Self.scope
        )
        XCTAssertFalse(late)
        let current = try await coordinator.open(scope: Self.scope, form: form)
        XCTAssertEqual(current.frozenSubmission, second.submission)
        XCTAssertEqual(current.phase, .submitting)
    }

    func testLiveSubmittingOperationSurvivesRecoveryWithoutBecomingUnknown() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationA })
        let form = Self.form(revision: Self.revisionA)
        try await fillRequiredValues(coordinator, form: form)
        let request = try await coordinator.beginSubmission(
            scope: Self.scope, form: form, ownerMessageText: "Please send this reviewed request."
        )

        let restored = try await coordinator.restoreUnsettled(ownerId: Self.scope.ownerId, sessionId: Self.scope.sessionId)
        XCTAssertEqual(restored.count, 1)
        XCTAssertEqual(restored.first?.phase, .submitting)
        XCTAssertEqual(restored.first?.frozenRequestBody, request.body)

        let restarted = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationB })
        let afterRestart = try await restarted.restoreUnsettled(ownerId: Self.scope.ownerId, sessionId: Self.scope.sessionId)
        XCTAssertEqual(afterRestart.first?.phase, .outcomeUnknown)
        XCTAssertEqual(afterRestart.first?.frozenRequestBody, request.body)
    }

    func testRecoveryFailsClosedForActivePointerWithMismatchedFrozenBody() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationA })
        let form = Self.form(revision: Self.revisionA)
        try await fillRequiredValues(coordinator, form: form)
        let pending = try await coordinator.beginSubmission(
            scope: Self.scope, form: form, ownerMessageText: "Please send this reviewed request."
        )
        let activePointer = CardFormActiveTaskPointer(taskId: Self.taskA, taskStatus: "running")
        _ = try await coordinator.recordOutcome(
            .init(operationId: pending.submission.operationId, outcome: .activeForm(activePointer)),
            scope: Self.scope
        )
        let loaded = try await storage.load(scope: Self.scope)
        var corrupted = try XCTUnwrap(loaded)
        corrupted.frozenRequestBody = Data("different request".utf8)
        await storage.replace(corrupted)

        do {
            _ = try await CardFormDraftCoordinator(storage: storage)
                .restoreUnsettled(ownerId: Self.scope.ownerId, sessionId: Self.scope.sessionId)
            XCTFail("A mismatched body must not publish the recovered active-task fence")
        } catch CardFormDraftError.submissionPending {}
    }

    func testEncodedRequestLimitRejectsBeforeFreezingAndKeepsAnswersEditable() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationA })
        let form = Self.form(revision: Self.revisionA)
        try await fillRequiredValues(coordinator, form: form)
        let escapedOwnerText = String(repeating: "\u{0001}", count: 4_000)
        do {
            _ = try await coordinator.beginSubmission(
                scope: Self.scope, form: form, ownerMessageText: escapedOwnerText
            )
            XCTFail("Encoded request bytes over 16 KiB must be rejected before an operation is frozen")
        } catch CardFormDraftError.requestTooLarge {}

        let loaded = try await storage.load(scope: Self.scope)
        let draft = try XCTUnwrap(loaded)
        XCTAssertEqual(draft.phase, .idle)
        XCTAssertNil(draft.frozenSubmission)
        XCTAssertNil(draft.frozenRequestBody)
        XCTAssertEqual(draft.values["name"], .text("Ada"))
        let stillEditable = try await coordinator.setValue(.text("Avery"), fieldId: "name", scope: Self.scope, form: form)
        XCTAssertEqual(stillEditable.values["name"], .text("Avery"))
    }

    func testFailedUnknownTransitionCanRetryOnlyTheSameDurableBody() async throws {
        let storage = MemoryCardFormStorage()
        let form = Self.form(revision: Self.revisionA)
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationA })
        try await fillRequiredValues(coordinator, form: form)
        let original = try await submit(coordinator, form: form)

        await storage.failNextSave()
        do {
            _ = try await coordinator.recordOutcome(
                .init(operationId: original.submission.operationId, outcome: .outcomeUnknown),
                scope: Self.scope
            )
            XCTFail("The injected secure-storage failure should reach the caller")
        } catch MemoryCardFormStorageError.injectedSaveFailure {}

        let retry = try await coordinator.retryUnknown(scope: Self.scope)
        XCTAssertEqual(retry, original)
        XCTAssertEqual(retry.body, original.body)
        let loaded = try await storage.load(scope: Self.scope)
        let persisted = try XCTUnwrap(loaded)
        XCTAssertEqual(persisted.frozenSubmission?.operationId, original.submission.operationId)
        XCTAssertEqual(persisted.phase, .submitting)
    }

    func testFieldValidationRejectsSensitiveWrongTypeInvalidDateAndMissingRequired() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage)
        let form = Self.form(revision: Self.revisionA)
        _ = try await coordinator.open(scope: Self.scope, form: form)
        do {
            _ = try await coordinator.setValue(.boolean(true), fieldId: "name", scope: Self.scope, form: form)
            XCTFail("Values must match the declared field kind")
        } catch CardFormDraftError.invalidValue("name") {}
        do {
            _ = try await coordinator.setValue(.choice("not-an-option"), fieldId: "time", scope: Self.scope, form: form)
            XCTFail("Choice values must use a declared option ID")
        } catch CardFormDraftError.invalidValue("time") {}
        do {
            _ = try await coordinator.setValue(.date("2026-02-30"), fieldId: "day", scope: Self.scope, form: form)
            XCTFail("Impossible calendar dates must be rejected")
        } catch CardFormDraftError.invalidValue("day") {}
        do {
            _ = try await submit(coordinator, form: form)
            XCTFail("Required values must be present")
        } catch CardFormDraftError.missingRequiredValue("name") {}

        let sensitive = Self.form(revision: Self.revisionA, fields: [
            .init(id: "secret", type: .text, label: "Account number", required: true, sensitive: true)
        ])
        do {
            _ = try await coordinator.open(scope: Self.scope, form: sensitive)
            XCTFail("The public protocol rejects private fields until a privacy projection exists")
        } catch CardFormDraftError.invalidForm {}
    }

    func testOwnerSessionClearErasesPendingDraftAndRequiresRotatedSession() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationA })
        let form = Self.form(revision: Self.revisionA)
        try await fillRequiredValues(coordinator, form: form)
        _ = try await submit(coordinator, form: form)
        try await coordinator.clearOwnerSession(ownerId: Self.scope.ownerId, sessionId: Self.scope.sessionId)
        try await coordinator.clearOwnerSession(ownerId: Self.scope.ownerId, sessionId: Self.scope.sessionId)
        let cleared = try await storage.load(scope: Self.scope)
        XCTAssertNil(cleared)
        do {
            _ = try await coordinator.open(scope: Self.scope, form: form)
            XCTFail("A logged-out session key cannot be reused")
        } catch CardFormDraftError.sessionClosed {}
        let newScope = CardFormScope(
            ownerId: Self.scope.ownerId,
            sessionId: "session-b",
            conversationId: Self.scope.conversationId,
            cardId: Self.scope.cardId,
            formId: Self.scope.formId
        )
        let fresh = try await coordinator.open(scope: newScope, form: form)
        XCTAssertNil(fresh.frozenSubmission)
        XCTAssertNil(fresh.values["name"])
        XCTAssertNil(fresh.values["remind"], "A new owner session starts with no implicit boolean answer")
    }

    func testTextLimitUsesJavaScriptCompatibleUTF16Length() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage)
        let form = Self.form(revision: Self.revisionA)
        _ = try await coordinator.open(scope: Self.scope, form: form)
        _ = try await coordinator.setValue(
            .text(String(repeating: "😀", count: 250)), fieldId: "name", scope: Self.scope, form: form
        )
        do {
            _ = try await coordinator.setValue(
                .text(String(repeating: "😀", count: 251)), fieldId: "name", scope: Self.scope, form: form
            )
            XCTFail("The protocol's 500-character limit follows JavaScript UTF-16 length")
        } catch CardFormDraftError.invalidValue("name") {}
    }

    func testCalendarDatesRemainExactAcrossLocalTimeZonesAndLeapDay() async throws {
        let originalTimeZone = NSTimeZone.default
        defer { NSTimeZone.default = originalTimeZone }
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { Self.operationA })
        let form = Self.form(revision: Self.revisionA)
        try await fillRequiredValues(coordinator, form: form)
        for name in ["Pacific/Honolulu", "Pacific/Kiritimati"] {
            NSTimeZone.default = try XCTUnwrap(TimeZone(identifier: name))
            _ = try await coordinator.setValue(.date("2028-02-29"), fieldId: "day", scope: Self.scope, form: form)
            let loaded = try await storage.load(scope: Self.scope)
            let draft = try XCTUnwrap(loaded)
            XCTAssertEqual(draft.values["day"], .date("2028-02-29"))
        }
        let request = try await submit(coordinator, form: form)
        XCTAssertEqual(request.submission.values["day"], .string("2028-02-29"),
            "The shipped date control is a calendar-date string and never converts midnight through local time")
    }

    func testCalendarDateRequiresAsciiPositiveADYear() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage)
        let form = Self.form(revision: Self.revisionA)
        _ = try await coordinator.open(scope: Self.scope, form: form)
        _ = try await coordinator.setValue(.date("2026-02-"), fieldId: "day", scope: Self.scope, form: form)
        _ = try await coordinator.setValue(.date("0001-01-01"), fieldId: "day", scope: Self.scope, form: form)
        _ = try await coordinator.setValue(.date("9999-12-31"), fieldId: "day", scope: Self.scope, form: form)
        for invalid in ["0000-01-01", "٢٠٢٦-02-03", "2026-٢٢-03"] {
            do {
                _ = try await coordinator.setValue(.date(invalid), fieldId: "day", scope: Self.scope, form: form)
                XCTFail("Date \(invalid) is outside the ASCII AD date contract")
            } catch CardFormDraftError.invalidValue("day") {}
        }
    }

    func testProtocolSafeFieldIDsRejectJavaScriptPrototypeNames() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage)
        for id in ["__proto__", "prototype", "constructor"] {
            let unsafe = Self.form(revision: Self.revisionA, fields: [
                .init(id: id, type: .text, label: "Value", required: false)
            ])
            do {
                _ = try await coordinator.open(scope: Self.scope, form: unsafe)
                XCTFail("Field ID \(id) is unsafe in an object-keyed values map")
            } catch CardFormDraftError.invalidForm {}
        }
    }

    func testChoiceOptionLabelsMustContainVisibleText() async throws {
        let storage = MemoryCardFormStorage()
        let coordinator = CardFormDraftCoordinator(storage: storage)
        let invalid = Self.form(revision: Self.revisionA, fields: [
            Self.form(revision: Self.revisionA).fields[0],
            .init(id: "time", type: .choice, label: "Time", required: true, options: [
                .init(id: "early", label: "  "), .init(id: "late", label: "Afternoon"),
            ]),
            Self.form(revision: Self.revisionA).fields[2],
            Self.form(revision: Self.revisionA).fields[3],
        ])
        do {
            _ = try await coordinator.open(scope: Self.scope, form: invalid)
            XCTFail("Whitespace-only option labels are not useful selectable values")
        } catch CardFormDraftError.invalidForm {}
    }

    func testScopeMismatchAndInvalidOperationIDFailClosed() async throws {
        let form = Self.form(revision: Self.revisionA)
        let mismatchCoordinator = CardFormDraftCoordinator(storage: MemoryCardFormStorage())
        do {
            _ = try await mismatchCoordinator.open(scope: Self.scope, form: Self.form(revision: Self.revisionB, cardId: Self.cardB))
            XCTFail("A form cannot be opened under another card's draft scope")
        } catch CardFormDraftError.scopeMismatch {}
        for invalidID in [
            "not-a-uuid",
            "00000000-0000-4000-8000-00000000000Ａ",
            "00000000-0000-9000-8000-000000000006",
            "00000000-0000-4000-c000-000000000006",
        ] {
            let storage = MemoryCardFormStorage()
            let coordinator = CardFormDraftCoordinator(storage: storage, makeOperationId: { invalidID })
            try await fillRequiredValues(coordinator, form: form)
            do {
                _ = try await submit(coordinator, form: form)
                XCTFail("Operation IDs must satisfy the server's strict UUID contract")
            } catch CardFormDraftError.invalidOperationId {}
        }
    }

    private func submit(
        _ coordinator: CardFormDraftCoordinator,
        scope: CardFormScope = CardFormDraftsTests.scope,
        form: CardFormDescriptor,
        ownerMessageText: String = "Please help with this saved-card request."
    ) async throws -> CardFormPendingRequest {
        try await coordinator.beginSubmission(
            scope: scope, form: form, ownerMessageText: ownerMessageText
        )
    }

    private static func submitResult(
        _ coordinator: CardFormDraftCoordinator,
        form: CardFormDescriptor
    ) async -> Result<CardFormPendingRequest, Error> {
        do { return .success(try await coordinator.beginSubmission(scope: scope, form: form, ownerMessageText: defaultOwnerMessageText)) }
        catch { return .failure(error) }
    }

    private func fillRequiredValues(
        _ coordinator: CardFormDraftCoordinator,
        form: CardFormDescriptor
    ) async throws {
        _ = try await coordinator.open(scope: Self.scope, form: form)
        _ = try await coordinator.setValue(.text("Ada"), fieldId: "name", scope: Self.scope, form: form)
        _ = try await coordinator.setValue(.choice("early"), fieldId: "time", scope: Self.scope, form: form)
        _ = try await coordinator.setValue(.date("2026-10-08"), fieldId: "day", scope: Self.scope, form: form)
    }

    private static func form(
        revision: String,
        cardId: String = cardA,
        fields: [CardFormField]? = nil
    ) -> CardFormDescriptor {
        .init(
            cardId: cardId,
            cardRevisionId: revision,
            formId: "travel-plan",
            title: "Plan the trip",
            submitLabel: "Review plan",
            serverAction: .submitOwnerChatTurn,
            fields: fields ?? [
                .init(id: "name", type: .text, label: "Traveler name", required: true),
                .init(id: "time", type: .choice, label: "Preferred time", required: true, options: [
                    .init(id: "early", label: "Morning"), .init(id: "late", label: "Afternoon"),
                ]),
                .init(id: "day", type: .date, label: "Date", required: true),
                .init(id: "remind", type: .boolean, label: "Remind me", required: false),
            ]
        )
    }

    private static let scope = CardFormScope(
        ownerId: "owner-a",
        sessionId: "session-a",
        conversationId: "00000000-0000-4000-8000-000000000001",
        cardId: "00000000-0000-4000-8000-000000000002",
        formId: "travel-plan"
    )
    private static let cardA = "00000000-0000-4000-8000-000000000002"
    private static let cardB = "00000000-0000-4000-8000-000000000099"
    private static let revisionA = "00000000-0000-4000-8000-000000000003"
    private static let revisionB = "00000000-0000-4000-8000-000000000004"
    private static let revisionC = "00000000-0000-4000-8000-000000000005"
    private static let operationA = "00000000-0000-4000-8000-000000000006"
    private static let operationB = "00000000-0000-4000-8000-000000000007"
    private static let taskA = "00000000-0000-4000-8000-000000000008"
    private static let taskB = "00000000-0000-4000-8000-000000000010"
    private static let messageA = "00000000-0000-4000-8000-000000000009"
    private static let defaultOwnerMessageText = "Please help with this saved-card request."
}

private enum MemoryCardFormStorageError: Error {
    case injectedSaveFailure
}

private actor MemoryCardFormStorage: CardFormDraftStorage {
    private var rows: [CardFormScope: CardFormDraft] = [:]
    private var shouldFailNextSave = false

    func load(scope: CardFormScope) async throws -> CardFormDraft? { rows[scope] }
    func failNextSave() { shouldFailNextSave = true }
    func replace(_ draft: CardFormDraft) { rows[draft.scope] = draft }
    func save(_ draft: CardFormDraft) async throws {
        if shouldFailNextSave {
            shouldFailNextSave = false
            throw MemoryCardFormStorageError.injectedSaveFailure
        }
        rows[draft.scope] = draft
    }
    func listScopes(ownerId: String, sessionId: String) async throws -> [CardFormScope] {
        rows.keys.filter { $0.ownerId == ownerId && $0.sessionId == sessionId }
    }
    func clear(ownerId: String, sessionId: String) async throws {
        rows = rows.filter { $0.key.ownerId != ownerId || $0.key.sessionId != sessionId }
    }
}

private final class LockedIds: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String]
    init(_ values: [String]) { self.values = values }
    func next() -> String {
        lock.lock()
        defer { lock.unlock() }
        return values.removeFirst()
    }
}
