import Foundation
import SwiftUI
import UIKit
import XCTest
@testable import Assistant

@MainActor
final class NativeMemoryCorrectionConsumerTests: XCTestCase {
    private let memoryA = "123e4567-e89b-12d3-a456-426614174001"
    private let memoryB = "123e4567-e89b-12d3-a456-426614174002"
    private let owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private let server = "https://assistant.example.test/api"
    private let original = "An existing saved note with enough text."
    private let draft = "A corrected saved note with enough text."

    func testAPIClientFactoryBindsSyntheticServerIssuedOMC1Handle() throws {
        let hash = String(repeating: "a", count: 64)
        let revision = String(repeating: "b", count: 64)
        let authorization = makeAuthorization(memoryID: memoryA, operationID: operationID,
                                              hash: hash, revision: revision, content: draft)
        let operation = try client.makeOwnerMemoryCorrectionOperation(memoryID: memoryA, authorization: authorization)
        XCTAssertTrue(operation.isBoundToServerAuthorization)
        XCTAssertEqual(operation.authorization.authorization, authorization.authorization)
        XCTAssertEqual(operation.request.memoryId, memoryA)
        XCTAssertEqual(operation.request.content, draft)
        XCTAssertEqual(operation.requestHash, authorization.requestHash)
    }

    func testDurableRecoveryAcknowledgementPrecedesSingleApply() async throws {
        let events = EventLog()
        let storage = MockCorrectionStorage(events: events)
        let transport = MockCorrectionTransport(events: events)
        let consumer = makeConsumer(storage: storage, transport: transport)

        await consumer.open(memoryID: memoryA)
        consumer.editDraft(draft)
        await save(consumer)

        let recordedEvents = await events.values
        let applies = await transport.applyCount
        XCTAssertEqual(recordedEvents, ["persist", "apply"])
        XCTAssertEqual(applies, 1)
        XCTAssertTrue(consumer.retainedOnDevice)
        XCTAssertEqual(consumer.presentation?.phase, .unknown)
    }

    func testStorageFailureNeverDispatchesApply() async throws {
        let events = EventLog()
        let storage = MockCorrectionStorage(events: events, failSave: true)
        let transport = MockCorrectionTransport(events: events)
        let consumer = makeConsumer(storage: storage, transport: transport)

        await consumer.open(memoryID: memoryA)
        consumer.editDraft(draft)
        await save(consumer)

        let recordedEvents = await events.values
        let authorizations = await transport.authorizationCount
        let applies = await transport.applyCount
        XCTAssertEqual(recordedEvents, ["persist"])
        XCTAssertEqual(authorizations, 1)
        XCTAssertEqual(applies, 0)
        XCTAssertEqual(consumer.presentation?.phase, .unavailable)
        XCTAssertFalse(consumer.retainedOnDevice)
    }

    func testCloseWhileDurableSaveIsHeldRemovesOperationWithoutApply() async throws {
        let events = EventLog()
        let storage = MockCorrectionStorage(events: events, holdSave: true)
        let transport = MockCorrectionTransport(events: events)
        let consumer = makeConsumer(storage: storage, transport: transport)
        await consumer.open(memoryID: memoryA)
        consumer.editDraft(draft)

        let saving = Task { await save(consumer) }
        await storage.waitForHeldSave()
        consumer.close()
        await storage.releaseSave()
        await saving.value

        let recordedEvents = await events.values
        let applies = await transport.applyCount
        let legacyWriteAllowed = await consumer.permitsLegacyWrite(memoryID: memoryA)
        XCTAssertEqual(recordedEvents, ["persist"])
        XCTAssertEqual(applies, 0)
        XCTAssertNil(consumer.presentation)
        XCTAssertFalse(consumer.retainedOnDevice)
        XCTAssertTrue(legacyWriteAllowed)
    }

    func testUnknownResultUsesExplicitStatusOnSameOperationWithoutReplay() async throws {
        let storage = MockCorrectionStorage()
        let transport = MockCorrectionTransport()
        let consumer = makeConsumer(storage: storage, transport: transport)
        await transport.setStatus(.savedReceipt)

        await consumer.open(memoryID: memoryA)
        consumer.editDraft(draft)
        await save(consumer)
        let issued = try XCTUnwrap(consumer.presentation?.operation)
        var state = try XCTUnwrap(consumer.presentation)
        let checkIntent = try XCTUnwrap(state.checkResult())
        consumer.updatePresentation(state)
        await consumer.handle(checkIntent)

        XCTAssertEqual(consumer.presentation?.phase, .saved)
        let authorizations = await transport.authorizationCount
        let applies = await transport.applyCount
        let statusReads = await transport.statusCount
        let checkedOperationIDs = await transport.statusOperationIDs
        XCTAssertEqual(authorizations, 1)
        XCTAssertEqual(applies, 1)
        XCTAssertEqual(statusReads, 1)
        XCTAssertEqual(checkedOperationIDs, [issued.operationID])
        XCTAssertEqual(consumer.presentation?.operation, issued)
    }

    func testPendingStatusCanBeExplicitlyCheckedAgainForSameOperation() async throws {
        let storage = MockCorrectionStorage()
        let transport = MockCorrectionTransport()
        let consumer = makeConsumer(storage: storage, transport: transport)
        await transport.setStatuses([.pending, .savedReceipt])

        await consumer.open(memoryID: memoryA)
        consumer.editDraft(draft)
        await save(consumer)
        let issued = try XCTUnwrap(consumer.presentation?.operation)

        var pendingState = try XCTUnwrap(consumer.presentation)
        XCTAssertEqual(pendingState.phase, .unknown)
        XCTAssertEqual(pendingState.outcomeVersion, 0)
        let pendingCheck = try XCTUnwrap(pendingState.checkResult())
        consumer.updatePresentation(pendingState)
        await consumer.handle(pendingCheck)
        XCTAssertEqual(consumer.presentation?.phase, .pending)
        XCTAssertEqual(consumer.presentation?.outcomeVersion, 0, "A status check must not fabricate a newer version")
        XCTAssertEqual(consumer.presentation?.isChecking, false)
        XCTAssertEqual(consumer.presentation?.canCheckResult, true)

        var terminalState = try XCTUnwrap(consumer.presentation)
        let terminalCheck = try XCTUnwrap(terminalState.checkResult())
        consumer.updatePresentation(terminalState)
        await consumer.handle(terminalCheck)

        let authorizations = await transport.authorizationCount
        let applies = await transport.applyCount
        let statusReads = await transport.statusCount
        let checkedIDs = await transport.statusOperationIDs
        XCTAssertEqual(consumer.presentation?.phase, .saved)
        XCTAssertEqual(consumer.presentation?.operation, issued)
        XCTAssertEqual(authorizations, 1)
        XCTAssertEqual(applies, 1)
        XCTAssertEqual(statusReads, 2)
        XCTAssertEqual(checkedIDs, [issued.operationID, issued.operationID])
    }

    func testUnchangedReceiptCanRetryFailedReadExplicitlyWithoutReapplying() async throws {
        let storage = MockCorrectionStorage()
        let transport = MockCorrectionTransport()
        let consumer = makeConsumer(storage: storage, transport: transport)
        await transport.setStatuses([.unchangedReceipt])
        await transport.setSnapshots([
            snapshot(memoryID: memoryA, revision: revisionA, content: original),
            snapshot(memoryID: memoryA, revision: String(repeating: "e", count: 64), content: draft),
        ])
        await transport.setSnapshotFailures([2]) // Opening read succeeds; receipt-triggered read fails.

        await consumer.open(memoryID: memoryA)
        consumer.editDraft(draft)
        await save(consumer)
        let issued = try XCTUnwrap(consumer.presentation?.operation)
        var checking = try XCTUnwrap(consumer.presentation)
        let checkIntent = try XCTUnwrap(checking.checkResult())
        consumer.updatePresentation(checking)
        await consumer.handle(checkIntent)

        XCTAssertEqual(consumer.presentation?.phase, .unchanged)
        XCTAssertNil(consumer.presentation?.resultReadback)
        XCTAssertTrue(consumer.presentation?.canRefreshSavedNote == true)
        XCTAssertTrue(consumer.retainedOnDevice)
        XCTAssertTrue(consumer.blockedMemoryIDs.contains(memoryA))

        var retrying = try XCTUnwrap(consumer.presentation)
        let refreshIntent = try XCTUnwrap(retrying.requestRefresh())
        consumer.updatePresentation(retrying)
        await consumer.handle(refreshIntent)

        let authorizations = await transport.authorizationCount
        let applies = await transport.applyCount
        let statusReads = await transport.statusCount
        let checkedIDs = await transport.statusOperationIDs
        XCTAssertEqual(consumer.presentation?.phase, .unchanged)
        XCTAssertEqual(consumer.presentation?.operation, issued)
        XCTAssertEqual(consumer.presentation?.resultReadback?.content, draft)
        XCTAssertFalse(consumer.presentation?.canRefreshSavedNote == true)
        XCTAssertFalse(consumer.retainedOnDevice)
        XCTAssertFalse(consumer.blockedMemoryIDs.contains(memoryA))
        XCTAssertEqual(authorizations, 1)
        XCTAssertEqual(applies, 1)
        XCTAssertEqual(statusReads, 1)
        XCTAssertEqual(checkedIDs, [issued.operationID])
    }

    func testRestartRestoresUnknownOperationAndOriginalDraftWithoutNetworkMutation() async throws {
        let storage = MockCorrectionStorage()
        let transport = MockCorrectionTransport()
        let first = makeConsumer(storage: storage, transport: transport)
        await first.open(memoryID: memoryA)
        first.editDraft(draft)
        await save(first)
        let originalOperation = try XCTUnwrap(first.presentation?.operation)
        let beforeAuth = await transport.authorizationCount
        let beforeApply = await transport.applyCount
        let beforeStatus = await transport.statusCount

        let reopened = makeConsumer(storage: storage, transport: transport)
        await reopened.open(memoryID: memoryA)

        XCTAssertEqual(reopened.presentation?.phase, .unknown)
        XCTAssertEqual(reopened.presentation?.draft, draft)
        XCTAssertEqual(reopened.presentation?.operation, originalOperation)
        XCTAssertTrue(reopened.retainedOnDevice)
        XCTAssertTrue(reopened.blockedMemoryIDs.contains(memoryA))
        let afterAuth = await transport.authorizationCount
        let afterApply = await transport.applyCount
        let afterStatus = await transport.statusCount
        XCTAssertEqual(afterAuth, beforeAuth)
        XCTAssertEqual(afterApply, beforeApply)
        XCTAssertEqual(afterStatus, beforeStatus)
    }

    func testExplicitReopenClearsTransientLoadPendingFailureBlock() async throws {
        let storage = MockCorrectionStorage(failLoadPendingCount: 1)
        let transport = MockCorrectionTransport()
        let consumer = makeConsumer(storage: storage, transport: transport)

        await consumer.open(memoryID: memoryA)
        XCTAssertNil(consumer.presentation)
        XCTAssertNotNil(consumer.errorMessage)
        XCTAssertTrue(consumer.blockedMemoryIDs.contains(memoryA))

        await consumer.open(memoryID: memoryA)

        let authorizations = await transport.authorizationCount
        let applies = await transport.applyCount
        let legacyWriteAllowed = await consumer.permitsLegacyWrite(memoryID: memoryA)
        XCTAssertEqual(consumer.presentation?.reviewedSnapshot.target.memoryID, memoryA)
        XCTAssertFalse(consumer.blockedMemoryIDs.contains(memoryA))
        XCTAssertTrue(legacyWriteAllowed)
        XCTAssertEqual(authorizations, 0)
        XCTAssertEqual(applies, 0)
    }

    func testStaleNilPendingLookupCannotClearNewSameTargetOperationBlock() async throws {
        let storage = MockCorrectionStorage(holdFirstLoad: true)
        let transport = MockCorrectionTransport()
        let consumer = makeConsumer(storage: storage, transport: transport)

        let olderOpen = Task { await consumer.open(memoryID: memoryA) }
        await storage.waitForHeldFirstLoad()
        await consumer.open(memoryID: memoryA)
        let snapshotsAfterCurrentOpen = await transport.snapshotCount
        XCTAssertEqual(consumer.presentation?.reviewedSnapshot.target.memoryID, memoryA)
        XCTAssertFalse(consumer.blockedMemoryIDs.contains(memoryA))

        consumer.editDraft(draft)
        await save(consumer)
        let issued = try XCTUnwrap(consumer.presentation?.operation)
        XCTAssertEqual(consumer.presentation?.phase, .unknown)
        XCTAssertTrue(consumer.retainedOnDevice)
        XCTAssertTrue(consumer.blockedMemoryIDs.contains(memoryA))

        await storage.releaseFirstLoadWithNil()
        await olderOpen.value

        let snapshotsAfterOldReply = await transport.snapshotCount
        let authorizations = await transport.authorizationCount
        let applies = await transport.applyCount
        let legacyWriteAllowed = await consumer.permitsLegacyWrite(memoryID: memoryA)
        XCTAssertEqual(snapshotsAfterOldReply, snapshotsAfterCurrentOpen,
                       "The stale nil lookup must not start another snapshot read")
        XCTAssertEqual(consumer.presentation?.operation?.operationID, issued.operationID)
        XCTAssertEqual(consumer.presentation?.phase, .unknown)
        XCTAssertTrue(consumer.retainedOnDevice)
        XCTAssertTrue(consumer.blockedMemoryIDs.contains(memoryA))
        XCTAssertFalse(legacyWriteAllowed)
        XCTAssertEqual(authorizations, 1)
        XCTAssertEqual(applies, 1)
    }

    func testScopeChangeRejectsLateSnapshotFromPreviousOwnerAndServer() async throws {
        let storage = MockCorrectionStorage()
        let transport = MockCorrectionTransport(heldMemoryID: memoryA)
        let consumer = NativeMemoryCorrectionConsumer(storage: storage)
        var currentOwner = owner
        var currentServer = server
        consumer.bind(scope: .init(ownerID: owner, serverIdentity: server), transport: transport,
                      isCurrent: { currentOwner == self.owner && currentServer == self.server }, hasGenericWrite: { _ in false })
        let firstOpen = Task { await consumer.open(memoryID: memoryA) }
        await transport.waitForHeldSnapshot()

        currentOwner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        currentServer = "https://other.example.test/api"
        consumer.bind(scope: .init(ownerID: currentOwner, serverIdentity: currentServer), transport: transport,
                      isCurrent: { currentOwner != self.owner && currentServer != self.server }, hasGenericWrite: { _ in false })
        await consumer.open(memoryID: memoryB)
        await transport.releaseHeldSnapshot()
        await firstOpen.value

        XCTAssertEqual(consumer.presentation?.reviewedSnapshot.target.ownerID, currentOwner)
        XCTAssertEqual(consumer.presentation?.reviewedSnapshot.target.serverID, currentServer)
        XCTAssertEqual(consumer.presentation?.reviewedSnapshot.target.memoryID, memoryB)
        XCTAssertNil(consumer.presentation?.reviewedSnapshot.target.sourceIdentity)
    }

    func testGenericWriteInterlockBlocksSameTargetButAllowsOtherTarget() async throws {
        let storage = MockCorrectionStorage()
        let transport = MockCorrectionTransport()
        let consumer = makeConsumer(storage: storage, transport: transport,
                                   hasGenericWrite: { $0 == self.memoryA })

        await consumer.open(memoryID: memoryA)
        consumer.editDraft(draft)
        await save(consumer)
        XCTAssertEqual(consumer.presentation?.phase, .unavailable)
        let blockedAuthorizations = await transport.authorizationCount
        let blockedApplies = await transport.applyCount
        XCTAssertEqual(blockedAuthorizations, 0)
        XCTAssertEqual(blockedApplies, 0)

        await consumer.open(memoryID: memoryB)
        consumer.editDraft(draft)
        await save(consumer)
        let finalAuthorizations = await transport.authorizationCount
        let finalApplies = await transport.applyCount
        XCTAssertEqual(finalAuthorizations, 1)
        XCTAssertEqual(finalApplies, 1)
        XCTAssertEqual(consumer.presentation?.reviewedSnapshot.target.memoryID, memoryB)
    }

    func testReceiptDoesNotConfirmReadbackWithDifferentRevisionOrMemoryID() async throws {
        let mismatchedReadbacks = [
            snapshot(memoryID: memoryA, revision: revisionB, content: draft),
            snapshot(memoryID: memoryB, revision: revisionA, content: draft),
        ]
        for readback in mismatchedReadbacks {
            let storage = MockCorrectionStorage()
            let transport = MockCorrectionTransport()
            await transport.setApplyAsSavedReceipt(true)
            await transport.setSnapshots([
                snapshot(memoryID: memoryA, revision: revisionA, content: original), readback,
            ], preserveSnapshotIDs: true)
            let consumer = makeConsumer(storage: storage, transport: transport)

            await consumer.open(memoryID: memoryA)
            consumer.editDraft(draft)
            await save(consumer)

            XCTAssertEqual(consumer.presentation?.phase, .saved)
            XCTAssertNil(consumer.presentation?.resultReadback)
            XCTAssertTrue(consumer.retainedOnDevice)
            XCTAssertTrue(consumer.blockedMemoryIDs.contains(memoryA))
        }
    }

    func testMatchingTerminalReceiptAndReadbackReleaseRecovery() async throws {
        let storage = MockCorrectionStorage()
        let transport = MockCorrectionTransport()
        await transport.setApplyAsSavedReceipt(true)
        await transport.setSnapshots([
            snapshot(memoryID: memoryA, revision: revisionA, content: original),
            snapshot(memoryID: memoryA, revision: String(repeating: "e", count: 64), content: draft),
        ])
        let consumer = makeConsumer(storage: storage, transport: transport)

        await consumer.open(memoryID: memoryA)
        consumer.editDraft(draft)
        await save(consumer)

        XCTAssertEqual(consumer.presentation?.phase, .saved)
        XCTAssertEqual(consumer.presentation?.resultReadback?.content, draft)
        XCTAssertFalse(consumer.retainedOnDevice)
        XCTAssertFalse(consumer.blockedMemoryIDs.contains(memoryA))
    }

    func testCleanupFailureAfterQualifiedReadbackKeepsTargetBlockedWithoutReplay() async throws {
        let storage = MockCorrectionStorage(failRemove: true)
        let transport = MockCorrectionTransport()
        await transport.setApplyAsSavedReceipt(true)
        await transport.setSnapshots([
            snapshot(memoryID: memoryA, revision: revisionA, content: original),
            snapshot(memoryID: memoryA, revision: String(repeating: "e", count: 64), content: draft),
        ])
        let consumer = makeConsumer(storage: storage, transport: transport)

        await consumer.open(memoryID: memoryA)
        consumer.editDraft(draft)
        await save(consumer)

        let authorizations = await transport.authorizationCount
        let applies = await transport.applyCount
        let legacyWriteAllowed = await consumer.permitsLegacyWrite(memoryID: memoryA)
        XCTAssertEqual(consumer.presentation?.phase, .saved)
        XCTAssertEqual(consumer.presentation?.resultReadback?.content, draft)
        XCTAssertFalse(consumer.retainedOnDevice)
        XCTAssertNotNil(consumer.cleanupMessage)
        XCTAssertTrue(consumer.blockedMemoryIDs.contains(memoryA))
        XCTAssertFalse(legacyWriteAllowed)
        XCTAssertEqual(authorizations, 1)
        XCTAssertEqual(applies, 1)
    }

    func testMountedScreenTaskOpensConsumerThroughInjectedSnapshotTransport() async throws {
        let targetMemoryID = self.memoryA
        let storage = MockCorrectionStorage()
        let transport = MockCorrectionTransport()
        let consumer = makeConsumer(storage: storage, transport: transport)
        let host = UIHostingController(rootView: NativeMemoryCorrectionScreen(
            consumer: consumer, memoryID: targetMemoryID,
            onOpen: { await consumer.open(memoryID: targetMemoryID) }, onClose: {}
        ))
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }

        let deadline = ContinuousClock.now + .seconds(2)
        while consumer.presentation == nil && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }

        XCTAssertEqual(consumer.presentation?.reviewedSnapshot.target.memoryID, memoryA)
        let snapshots = await transport.snapshotCount
        XCTAssertEqual(snapshots, 1)
    }

    func testMobileRouteReadOnlyReasonCodesMapToSafeText() {
        let routeReasons = [
            "invalid_owner_or_identity", "malformed_owner_correction", "unsupported_memory_category",
            "expired_or_invalid_lifecycle", "superseded", "quarantined", "tombstoned",
            "incomplete_provenance", "shared_source", "conflicting_lineage", "unverified_subject",
            "source_identity_mismatch", "unverified_extraction_source", "unsupported_import_provenance",
            "unknown_provenance", "memory_content_hash_mismatch",
        ]
        for reason in routeReasons {
            let message = NativeMemoryCorrectionConsumer.readOnlyMessage(for: reason)
            XCTAssertFalse(message.isEmpty)
            XCTAssertNotEqual(message, reason)
            XCTAssertFalse(message.contains("_"), "Protocol reason codes must not be shown to owners")
        }
        XCTAssertEqual(NativeMemoryCorrectionConsumer.readOnlyMessage(for: nil),
                       NativeMemoryCorrectionConsumer.readOnlyMessage(for: "future_private_classifier"))
        XCTAssertEqual(NativeMemoryCorrectionConsumer.readOnlyMessage(for: "unverified_source"),
                       NativeMemoryCorrectionConsumer.readOnlyMessage(for: "future_private_classifier"))
    }

    func testWireReadOnlyReasonsAreMappedBeforePresentationAndCannotAuthorize() async throws {
        let storage = MockCorrectionStorage()
        let transport = MockCorrectionTransport()
        let consumer = makeConsumer(storage: storage, transport: transport)
        let wireReasons = ["shared_source", "memory_content_hash_mismatch", "future_private_classifier"]

        for reason in wireReasons {
            await transport.setSnapshots([
                snapshot(memoryID: memoryA, revision: revisionA, content: original,
                         eligible: false, readOnlyReason: reason),
            ])
            await consumer.open(memoryID: memoryA)
            XCTAssertEqual(consumer.presentation?.statusText,
                           NativeMemoryCorrectionConsumer.readOnlyMessage(for: reason))
            XCTAssertFalse(consumer.presentation?.canRequestAuthorization == true)
        }

        let authorizations = await transport.authorizationCount
        let applies = await transport.applyCount
        XCTAssertEqual(authorizations, 0)
        XCTAssertEqual(applies, 0)
    }

    private var operationID: String { "123e4567-e89b-12d3-a456-426614174003" }
    private var revisionA: String { String(repeating: "a", count: 64) }
    private var revisionB: String { String(repeating: "b", count: 64) }

    private var client: APIClient {
        APIClient(configuration: APIConfiguration(baseURL: URL(string: server)!, token: "synthetic-test-token"),
                  clientID: "synthetic-client-id")
    }

    private func makeConsumer(storage: MockCorrectionStorage, transport: MockCorrectionTransport,
                              hasGenericWrite: @escaping @MainActor (String) -> Bool = { _ in false }) -> NativeMemoryCorrectionConsumer {
        let consumer = NativeMemoryCorrectionConsumer(storage: storage)
        consumer.bind(scope: .init(ownerID: owner, serverIdentity: server), transport: transport,
                      isCurrent: { true }, hasGenericWrite: hasGenericWrite)
        return consumer
    }

    private func save(_ consumer: NativeMemoryCorrectionConsumer) async {
        guard var state = consumer.presentation,
              let intent = state.requestSave() else {
            XCTFail("The fixture should permit an explicit save request")
            return
        }
        consumer.updatePresentation(state)
        await consumer.handle(intent)
    }

    private func snapshot(memoryID: String, revision: String, content: String,
                          eligible: Bool = true, readOnlyReason: String? = nil) -> OwnerMemoryCorrectionSnapshot {
        .init(memoryId: memoryID, content: content, contentHash: Self.contentHash,
              revision: revision, sourceLabel: "Saved note", eligible: eligible,
              readOnlyReason: readOnlyReason, ownerCorrected: false)
    }

    private static let contentHash = String(repeating: "c", count: 64)

    private func makeAuthorization(memoryID: String, operationID: String, hash: String,
                                   revision: String, content: String) -> OwnerMemoryCorrectionAuthorization {
        let requestHash = OwnerMemoryCorrectionApplyRequest(memoryId: memoryID, operationId: operationID,
            expectedContentHash: hash, expectedMemoryRevision: revision, content: content).canonicalRequestHash
        let claims: [String: Any] = [
            "version": 1, "purpose": "mobile_owner_memory_correction",
            "principal": ["kind": "configured_installation_bearer"],
            "scope": ["ownerId": owner, "sessionDigest": String(repeating: "d", count: 64),
                      "epoch": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "privacyGeneration": NSNull(),
                      "command": "correct_owner_memory", "operationId": operationID, "targetId": memoryID,
                      "nonce": "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "issuedAt": 1_000, "expiresAt": 601_000],
            "expectedContentHash": hash, "expectedMemoryRevision": revision, "requestHash": requestHash,
        ]
        let payload = try! JSONSerialization.data(withJSONObject: claims, options: [.sortedKeys])
            .base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let handle = "omc1.\(payload).\(String(repeating: "A", count: 43))"
        let response = OwnerMemoryCorrectionAuthorizationResponse(version: 1, intent: "authorized",
            command: "correct_owner_memory", memoryId: memoryID, operationId: operationID,
            authorization: handle, expiresAt: "synthetic-expiry")
        return OwnerMemoryCorrectionAuthorization(response: response, expectedContentHash: hash,
            expectedMemoryRevision: revision, content: content)
    }
}

private actor EventLog {
    private(set) var values: [String] = []
    func append(_ value: String) { values.append(value) }
}

private actor MockCorrectionStorage: NativeMemoryCorrectionStorage {
    private var pending: NativeMemoryCorrectionRecoveryRecord?
    private let events: EventLog?
    private let failSave: Bool
    private let failRemove: Bool
    private let holdSave: Bool
    private var failLoadPendingCount: Int
    private let holdFirstLoad: Bool
    private var firstLoadHeld = false
    private var firstLoadContinuation: CheckedContinuation<NativeMemoryCorrectionRecoveryRecord?, Error>?
    private var firstLoadWaiter: CheckedContinuation<Void, Never>?
    private var saveHeld = false
    private var saveContinuation: CheckedContinuation<Void, Never>?
    private var saveWaiter: CheckedContinuation<Void, Never>?

    init(events: EventLog? = nil, failSave: Bool = false, holdSave: Bool = false,
         failRemove: Bool = false, failLoadPendingCount: Int = 0, holdFirstLoad: Bool = false) {
        self.events = events
        self.failSave = failSave
        self.holdSave = holdSave
        self.failRemove = failRemove
        self.failLoadPendingCount = failLoadPendingCount
        self.holdFirstLoad = holdFirstLoad
    }

    func saveBeforeDispatch(_ record: NativeMemoryCorrectionRecoveryRecord) async throws {
        await events?.append("persist")
        guard !failSave else { throw MockFailure.storage }
        pending = record
        if holdSave {
            saveHeld = true
            saveWaiter?.resume(); saveWaiter = nil
            await withCheckedContinuation { saveContinuation = $0 }
        }
    }

    func loadPending(serverIdentity: String, target: NativeMemoryCorrectionRecoveryRecord.Target) async throws -> NativeMemoryCorrectionRecoveryRecord? {
        if holdFirstLoad && !firstLoadHeld {
            firstLoadHeld = true
            firstLoadWaiter?.resume(); firstLoadWaiter = nil
            return try await withCheckedThrowingContinuation { firstLoadContinuation = $0 }
        }
        if failLoadPendingCount > 0 {
            failLoadPendingCount -= 1
            throw MockFailure.storage
        }
        guard let pending, pending.serverIdentity == serverIdentity, pending.target == target else { return nil }
        return pending
    }

    func remove(serverIdentity: String, target: NativeMemoryCorrectionRecoveryRecord.Target,
                operationID: String, disposition: NativeMemoryCorrectionRecoveryTerminalDisposition) async throws {
        guard !failRemove else { throw MockFailure.storage }
        guard pending?.serverIdentity == serverIdentity, pending?.target == target,
              pending?.operation.operationID == operationID else { return }
        pending = nil
    }

    func waitForHeldSave() async {
        if saveHeld { return }
        await withCheckedContinuation { saveWaiter = $0 }
    }
    func releaseSave() { saveContinuation?.resume(); saveContinuation = nil }
    func waitForHeldFirstLoad() async {
        if firstLoadHeld { return }
        await withCheckedContinuation { firstLoadWaiter = $0 }
    }
    func releaseFirstLoadWithNil() {
        firstLoadContinuation?.resume(returning: nil); firstLoadContinuation = nil
    }
}

private actor MockCorrectionTransport: NativeMemoryCorrectionTransport {
    private nonisolated let client = APIClient(configuration: APIConfiguration(
        baseURL: URL(string: "https://assistant.example.test/api")!, token: "synthetic-test-token"),
        clientID: "synthetic-client-id")
    private let events: EventLog?
    private let heldMemoryID: String?
    private var heldContinuation: CheckedContinuation<OwnerMemoryCorrectionSnapshot, Error>?
    private var heldStarted = false
    private var startWaiter: CheckedContinuation<Void, Never>?
    private var snapshots: [OwnerMemoryCorrectionSnapshot]
    private var nextSnapshot = 0
    private var preserveSnapshotIDs = false
    private var applyAsSavedReceipt = false
    private var statusReplies: [StatusReply] = []
    private var snapshotFailureCalls = Set<Int>()
    private(set) var snapshotCount = 0
    private(set) var authorizationCount = 0
    private(set) var applyCount = 0
    private(set) var statusCount = 0
    private(set) var statusOperationIDs: [String] = []

    init(events: EventLog? = nil, heldMemoryID: String? = nil) {
        self.events = events
        self.heldMemoryID = heldMemoryID
        let initial = OwnerMemoryCorrectionSnapshot(memoryId: "123e4567-e89b-12d3-a456-426614174001",
            content: "An existing saved note with enough text.", contentHash: String(repeating: "c", count: 64),
            revision: String(repeating: "a", count: 64), sourceLabel: "Saved note", eligible: true,
            readOnlyReason: nil, ownerCorrected: false)
        snapshots = [initial]
    }

    func ownerMemoryCorrectionSnapshot(memoryID: String) async throws -> OwnerMemoryCorrectionSnapshot {
        snapshotCount += 1
        if snapshotFailureCalls.remove(snapshotCount) != nil { throw MockFailure.missingSnapshot }
        if memoryID == heldMemoryID {
            heldStarted = true
            startWaiter?.resume(); startWaiter = nil
            return try await withCheckedThrowingContinuation { heldContinuation = $0 }
        }
        if snapshots.isEmpty { throw MockFailure.missingSnapshot }
        let selected = snapshots[min(nextSnapshot, snapshots.count - 1)]
        nextSnapshot += 1
        if preserveSnapshotIDs || selected.memoryId == memoryID { return selected }
        return OwnerMemoryCorrectionSnapshot(memoryId: memoryID, content: selected.content,
            contentHash: selected.contentHash, revision: selected.revision, sourceLabel: selected.sourceLabel,
            eligible: selected.eligible, readOnlyReason: selected.readOnlyReason, ownerCorrected: selected.ownerCorrected)
    }

    func authorizeOwnerMemoryCorrection(memoryID: String, expectedContentHash: String,
        expectedMemoryRevision: String, content: String) async throws -> OwnerMemoryCorrectionAuthorization {
        authorizationCount += 1
        return makeAuthorization(memoryID: memoryID, hash: expectedContentHash,
                                 revision: expectedMemoryRevision, content: content)
    }

    nonisolated func makeOwnerMemoryCorrectionOperation(memoryID: String,
        authorization: OwnerMemoryCorrectionAuthorization) throws -> OwnerMemoryCorrectionOperation {
        try client.makeOwnerMemoryCorrectionOperation(memoryID: memoryID, authorization: authorization)
    }

    func applyOwnerMemoryCorrection(_ operation: OwnerMemoryCorrectionOperation) async -> OwnerMemoryCorrectionApplyResult {
        await events?.append("apply")
        applyCount += 1
        if applyAsSavedReceipt {
            return .replied(OwnerMemoryCorrectionReply(version: 1, authority: "operation_receipt",
                command: "correct_owner_memory", operationId: operation.authorization.operationId,
                outcome: "saved", reason: nil, fieldErrors: nil,
                ids: ["memoryId": operation.memoryId], originalOperationTerminal: nil,
                revision: String(repeating: "e", count: 64), statusVersion: 1,
                requestHash: operation.requestHash))
        }
        return .uncertain(operation)
    }

    func ownerMemoryCorrectionStatus(_ operation: OwnerMemoryCorrectionOperation) async throws -> OwnerMemoryCorrectionReply {
        statusCount += 1
        statusOperationIDs.append(operation.authorization.operationId)
        guard !statusReplies.isEmpty else { throw MockFailure.noStatus }
        switch statusReplies.removeFirst() {
        case .pending:
            return OwnerMemoryCorrectionReply(version: 1, authority: "unresolved",
                command: "correct_owner_memory", operationId: operation.authorization.operationId,
                outcome: "outcome_unknown", reason: "preparing", fieldErrors: nil, ids: nil,
                originalOperationTerminal: nil, revision: nil, statusVersion: nil, requestHash: nil)
        case .savedReceipt:
            return OwnerMemoryCorrectionReply(version: 1, authority: "operation_receipt",
                command: "correct_owner_memory", operationId: operation.authorization.operationId,
                outcome: "saved", reason: nil, fieldErrors: nil, ids: ["memoryId": operation.memoryId],
                originalOperationTerminal: nil, revision: String(repeating: "e", count: 64),
                statusVersion: 1, requestHash: operation.requestHash)
        case .unchangedReceipt:
            return OwnerMemoryCorrectionReply(version: 1, authority: "operation_receipt",
                command: "correct_owner_memory", operationId: operation.authorization.operationId,
                outcome: "unchanged", reason: nil, fieldErrors: nil, ids: ["memoryId": operation.memoryId],
                originalOperationTerminal: nil, revision: String(repeating: "e", count: 64),
                statusVersion: 1, requestHash: operation.requestHash)
        }
    }

    func setStatus(_ status: StatusReply) {
        statusReplies = [status]
    }
    func setStatuses(_ statuses: [StatusReply]) { statusReplies = statuses }
    func setSnapshotFailures(_ callNumbers: Set<Int>) { snapshotFailureCalls = callNumbers }

    func setApplyAsSavedReceipt(_ enabled: Bool) { applyAsSavedReceipt = enabled }
    func setSnapshots(_ snapshots: [OwnerMemoryCorrectionSnapshot], preserveSnapshotIDs: Bool = false) {
        self.snapshots = snapshots; nextSnapshot = 0; self.preserveSnapshotIDs = preserveSnapshotIDs
    }
    func waitForHeldSnapshot() async {
        if heldStarted { return }
        await withCheckedContinuation { startWaiter = $0 }
    }
    func releaseHeldSnapshot() {
        heldContinuation?.resume(returning: snapshots[0]); heldContinuation = nil
    }

    private func makeAuthorization(memoryID: String, hash: String, revision: String,
                                   content: String) -> OwnerMemoryCorrectionAuthorization {
        let requestHash = OwnerMemoryCorrectionApplyRequest(memoryId: memoryID, operationId: operationID,
            expectedContentHash: hash, expectedMemoryRevision: revision, content: content).canonicalRequestHash
        let claims: [String: Any] = ["version": 1, "purpose": "mobile_owner_memory_correction",
            "principal": ["kind": "configured_installation_bearer"],
            "scope": ["ownerId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "sessionDigest": String(repeating: "d", count: 64),
                "epoch": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "privacyGeneration": NSNull(),
                "command": "correct_owner_memory", "operationId": operationID, "targetId": memoryID,
                "nonce": "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "issuedAt": 1_000, "expiresAt": 601_000],
            "expectedContentHash": hash, "expectedMemoryRevision": revision, "requestHash": requestHash]
        let payload = try! JSONSerialization.data(withJSONObject: claims, options: [.sortedKeys])
            .base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let handle = "omc1.\(payload).\(String(repeating: "A", count: 43))"
        let response = OwnerMemoryCorrectionAuthorizationResponse(version: 1, intent: "authorized",
            command: "correct_owner_memory", memoryId: memoryID, operationId: operationID,
            authorization: handle, expiresAt: "synthetic-expiry")
        return OwnerMemoryCorrectionAuthorization(response: response, expectedContentHash: hash,
            expectedMemoryRevision: revision, content: content)
    }

    private var operationID: String { "123e4567-e89b-12d3-a456-426614174003" }
    private var memoryID: String { "123e4567-e89b-12d3-a456-426614174001" }
}

private enum StatusReply { case pending, savedReceipt, unchangedReceipt }
private enum MockFailure: Error { case storage, missingSnapshot, noStatus }
