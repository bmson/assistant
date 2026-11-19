import CryptoKit
import Foundation
import XCTest
@testable import Assistant

final class NativeMemoryCorrectionRecoveryTests: XCTestCase {
    func testEncryptedRoundTripUsesFullServerPathAndExactOperationTuple() async throws {
        let files = RecoveryMemoryFiles()
        let vault = RecoveryMemoryVault()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try makeStore(files: files, vault: vault, root: root)
        let record = fixture()
        try await store.saveBeforeDispatch(record)

        let reopened = try makeStore(files: files, vault: vault, root: root)
        let recovered = try await reopened.load(serverIdentity: record.serverIdentity,
                                                target: record.target,
                                                operationID: record.operation.operationID)
        XCTAssertEqual(recovered, record)
        let foreignServer = try await reopened.load(serverIdentity: "https://example.test/assistant/other",
                                                    target: record.target,
                                                    operationID: record.operation.operationID)
        XCTAssertNil(foreignServer)
        XCTAssertEqual(recovered?.authorizationExpiresAt, record.authorizationExpiresAt)
        for bytes in files.values {
            XCTAssertNil(bytes.range(of: Data(record.draft.utf8)))
            XCTAssertNil(bytes.range(of: Data(record.authorizationHandle.utf8)))
            XCTAssertNil(bytes.range(of: Data(record.operation.operationID.utf8)))
            XCTAssertNil(bytes.range(of: Data("never-persist-this-bearer".utf8)))
        }
    }

    func testPendingLocatorSurvivesStoreRecreationAndQualifiedRemovalClearsIt() async throws {
        let files = RecoveryMemoryFiles()
        let vault = RecoveryMemoryVault()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let record = fixture(authorizationExpiresAt: "2026-11-03T00:00:00.000Z")
        try await makeStore(files: files, vault: vault, root: root).saveBeforeDispatch(record)

        let reopened = try makeStore(files: files, vault: vault, root: root)
        let recovered = try await reopened.loadPending(serverIdentity: record.serverIdentity, target: record.target)
        XCTAssertEqual(recovered, record)
        try await reopened.remove(serverIdentity: record.serverIdentity, target: record.target,
                                  operationID: record.operation.operationID,
                                  disposition: .rejectedNoWrite)
        let pendingAfterRemoval = try await reopened.loadPending(serverIdentity: record.serverIdentity, target: record.target)
        XCTAssertNil(pendingAfterRemoval)
        XCTAssertTrue(files.values.isEmpty)
    }

    func testPendingLocatorConflictBlocksDifferentOperationBeforeDispatchAndKeepsOriginal() async throws {
        let files = RecoveryMemoryFiles()
        let store = try makeStore(files: files, vault: RecoveryMemoryVault())
        let first = fixture(operationID: "pending-A")
        let second = fixture(operationID: "pending-B", draft: "Another authorized correction")
        try await store.saveBeforeDispatch(first)
        do {
            try await store.saveBeforeDispatch(second)
            XCTFail("A second operation must fail before the caller can dispatch it")
        } catch let error as NativeMemoryCorrectionRecoveryError {
            XCTAssertEqual(error, .operationConflict)
        }
        let unpublished = try await store.load(serverIdentity: second.serverIdentity, target: second.target,
                                               operationID: second.operation.operationID)
        XCTAssertNil(unpublished, "The conflict is detected before storing an undiscoverable second operation.")
        let pending = try await store.loadPending(serverIdentity: first.serverIdentity, target: first.target)
        XCTAssertEqual(pending, first)
        XCTAssertEqual(files.values.count, 2) // The first operation and its encrypted locator remain.
    }

    func testTamperedPendingLocatorFailsClosedAndIsNotReplacedOrRemoved() async throws {
        let files = RecoveryMemoryFiles()
        let store = try makeStore(files: files, vault: RecoveryMemoryVault())
        let record = fixture()
        try await store.saveBeforeDispatch(record)
        let locatorPath = try XCTUnwrap(files.paths.first(where: { $0.hasSuffix("pending.nmcp") }))
        var bytes = try XCTUnwrap(files.value(at: locatorPath))
        bytes[bytes.count - 1] ^= 0xff
        files.replace(bytes, at: locatorPath)

        do {
            _ = try await store.loadPending(serverIdentity: record.serverIdentity, target: record.target)
            XCTFail("A tampered locator must not be interpreted as no pending operation")
        } catch let error as NativeMemoryCorrectionRecoveryError {
            XCTAssertEqual(error, .corruptRecord)
        }
        do {
            try await store.saveBeforeDispatch(record)
            XCTFail("A corrupt pending locator must not be overwritten")
        } catch let error as NativeMemoryCorrectionRecoveryError {
            XCTAssertEqual(error, .corruptRecord)
        }
        do {
            try await store.remove(serverIdentity: record.serverIdentity, target: record.target,
                                   operationID: record.operation.operationID,
                                   disposition: .rejectedNoWrite)
            XCTFail("A corrupt pending locator must prevent deletion")
        } catch let error as NativeMemoryCorrectionRecoveryError {
            XCTAssertEqual(error, .corruptRecord)
        }
        XCTAssertEqual(files.value(at: locatorPath), bytes)
        XCTAssertEqual(files.values.count, 2)
    }

    func testPendingLocatorIsPartitionedByFullTargetAndServer() async throws {
        let files = RecoveryMemoryFiles()
        let store = try makeStore(files: files, vault: RecoveryMemoryVault())
        let record = fixture()
        try await store.saveBeforeDispatch(record)
        let otherTargets = [
            NativeMemoryCorrectionRecoveryRecord.Target(ownerID: "owner-b", serverID: record.target.serverID,
                memoryID: record.target.memoryID, sourceIdentity: record.target.sourceIdentity),
            NativeMemoryCorrectionRecoveryRecord.Target(ownerID: record.target.ownerID, serverID: "server-b",
                memoryID: record.target.memoryID, sourceIdentity: record.target.sourceIdentity),
            NativeMemoryCorrectionRecoveryRecord.Target(ownerID: record.target.ownerID, serverID: record.target.serverID,
                memoryID: record.target.memoryID, sourceIdentity: "source-b"),
        ]
        for target in otherTargets {
            let pending = try await store.loadPending(serverIdentity: record.serverIdentity, target: target)
            XCTAssertNil(pending)
        }
        let otherServer = try await store.loadPending(serverIdentity: "https://example.test/other", target: record.target)
        XCTAssertNil(otherServer)
        let pending = try await store.loadPending(serverIdentity: record.serverIdentity, target: record.target)
        XCTAssertEqual(pending, record)
    }

    func testPendingLocatorWriteFailureRollsBackNewCandidateAndBlocksDispatch() async throws {
        let files = RecoveryMemoryFiles()
        let vault = RecoveryMemoryVault()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try makeStore(files: files, vault: vault, root: root)
        let record = fixture()
        files.failPendingLocatorWrites = true
        do {
            try await store.saveBeforeDispatch(record)
            XCTFail("Failure to install discoverability must block dispatch")
        } catch let error as EncryptedCardFormDraftStorageError {
            XCTAssertEqual(error, .writeFailed)
        }
        files.failPendingLocatorWrites = false
        XCTAssertTrue(files.values.isEmpty, "The newly installed pre-dispatch candidate is verified and removed.")
        let pending = try await store.loadPending(serverIdentity: record.serverIdentity, target: record.target)
        XCTAssertNil(pending)
        let operation = try await store.load(serverIdentity: record.serverIdentity, target: record.target,
                                             operationID: record.operation.operationID)
        XCTAssertNil(operation)
        let reopened = try makeStore(files: files, vault: vault, root: root)
        let reopenedPending = try await reopened.loadPending(serverIdentity: record.serverIdentity, target: record.target)
        XCTAssertNil(reopenedPending, "A fresh store must not discover a candidate whose publication rolled back.")
    }

    func testPreexistingOperationLocatorFailureIsReportedAsUncertainWithoutDeletingCandidate() async throws {
        let files = RecoveryMemoryFiles()
        let vault = RecoveryMemoryVault()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try makeStore(files: files, vault: vault, root: root)
        let record = fixture(operationID: "preexisting-without-locator")
        try await store.saveBeforeDispatch(record)
        let locatorPath = try XCTUnwrap(files.paths.first(where: { $0.hasSuffix("pending.nmcp") }))
        try files.removeFile(URL(fileURLWithPath: locatorPath))
        files.failPendingLocatorWrites = true

        do {
            try await store.saveBeforeDispatch(record)
            XCTFail("The caller must not dispatch when recovery discoverability cannot be restored.")
        } catch let error as NativeMemoryCorrectionRecoveryError {
            XCTAssertEqual(error, .recoveryCleanupUncertain)
        }
        XCTAssertTrue(files.paths.contains(where: { $0.hasSuffix(".nmcr") }),
                      "The store cannot delete an operation it did not create in this save attempt.")
        XCTAssertFalse(files.paths.contains(where: { $0.hasSuffix("pending.nmcp") }))
        let reopened = try makeStore(files: files, vault: vault, root: root)
        let pendingWhileWritesFail = try await reopened.loadPending(serverIdentity: record.serverIdentity,
                                                                    target: record.target)
        XCTAssertNil(pendingWhileWritesFail,
                     "If the adapter cannot publish a locator, durable target discovery cannot be promised.")

        files.failPendingLocatorWrites = false
        try await reopened.saveBeforeDispatch(record)
        let recovered = try await reopened.loadPending(serverIdentity: record.serverIdentity, target: record.target)
        XCTAssertEqual(recovered, record)
    }

    func testTerminalCleanupMarkerRecoversAfterOperationOrLocatorDeleteFailure() async throws {
        for failingComponent in ["operation", "locator"] {
            let files = RecoveryMemoryFiles()
            let vault = RecoveryMemoryVault()
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = try makeStore(files: files, vault: vault, root: root)
            let record = fixture(operationID: "cleanup-\(failingComponent)")
            try await store.saveBeforeDispatch(record)
            files.failRemovePath = try XCTUnwrap(files.paths.first(where: {
                failingComponent == "operation" ? $0.hasSuffix(".nmcr") : $0.hasSuffix("pending.nmcp")
            }))
            do {
                try await store.remove(serverIdentity: record.serverIdentity, target: record.target,
                                       operationID: record.operation.operationID,
                                       disposition: .rejectedNoWrite)
                XCTFail("The injected delete failure should preserve a cleanup marker")
            } catch { }
            XCTAssertTrue(files.paths.contains(where: { $0.hasSuffix("terminal-cleanup.nmct") }))
            if failingComponent == "locator" {
                XCTAssertFalse(files.paths.contains(where: { $0.hasSuffix(".nmcr") }),
                                "Operation deletion completed before the injected locator deletion failure.")
                XCTAssertTrue(files.paths.contains(where: { $0.hasSuffix("pending.nmcp") }))
            } else {
                XCTAssertTrue(files.paths.contains(where: { $0.hasSuffix(".nmcr") }))
                XCTAssertTrue(files.paths.contains(where: { $0.hasSuffix("pending.nmcp") }))
            }
            files.failRemovePath = nil

            let reopened = try makeStore(files: files, vault: vault, root: root)
            let pending = try await reopened.loadPending(serverIdentity: record.serverIdentity, target: record.target)
            XCTAssertNil(pending, "The authenticated marker resumes exact cleanup after reopening.")
            XCTAssertTrue(files.values.isEmpty)
        }
    }

    func testUnchangedNoWriteCleanupMarkerResumesOnlyItsOwnDispositionAfterReopen() async throws {
        let files = RecoveryMemoryFiles()
        let vault = RecoveryMemoryVault()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let record = fixture(operationID: "unchanged-no-write-reopen")
        let store = try makeStore(files: files, vault: vault, root: root)
        try await store.saveBeforeDispatch(record)
        files.failRemovePath = try XCTUnwrap(files.paths.first(where: { $0.hasSuffix(".nmcr") }))

        do {
            try await store.remove(serverIdentity: record.serverIdentity, target: record.target,
                                   operationID: record.operation.operationID,
                                   disposition: .unchangedNoWrite)
            XCTFail("The failed deletion must leave its authenticated no-write marker discoverable.")
        } catch { }
        let markerPath = try XCTUnwrap(files.paths.first(where: { $0.hasSuffix("terminal-cleanup.nmct") }))
        XCTAssertTrue(files.paths.contains(where: { $0.hasSuffix(".nmcr") }))
        XCTAssertTrue(files.paths.contains(where: { $0.hasSuffix("pending.nmcp") }))

        do {
            try await store.remove(serverIdentity: record.serverIdentity, target: record.target,
                                   operationID: record.operation.operationID,
                                   disposition: .unchangedWithOperationBoundReadback)
            XCTFail("The legacy readback disposition must not silently reuse the no-write marker.")
        } catch let error as NativeMemoryCorrectionRecoveryError {
            XCTAssertEqual(error, .operationConflict)
        }
        XCTAssertTrue(files.paths.contains(markerPath))

        files.failRemovePath = nil
        let reopened = try makeStore(files: files, vault: vault, root: root)
        let pending = try await reopened.loadPending(serverIdentity: record.serverIdentity, target: record.target)
        XCTAssertNil(pending)
        XCTAssertTrue(files.values.isEmpty, "A fresh store resumes only the exact authenticated no-write cleanup.")
    }

    func testTamperedOrForeignScopeCleanupMarkerFailsClosed() async throws {
        let files = RecoveryMemoryFiles()
        let vault = RecoveryMemoryVault()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try makeStore(files: files, vault: vault, root: root)
        let record = fixture(operationID: "cleanup-source")
        let foreign = fixture(operationID: "cleanup-foreign", memoryID: "memory-2")
        try await store.saveBeforeDispatch(record)
        try await store.saveBeforeDispatch(foreign)
        files.failRemovePath = try XCTUnwrap(files.paths.first(where: {
            $0.hasSuffix(".nmcr") && $0.contains(recoveryPartition(record))
        }))
        do {
            try await store.remove(serverIdentity: record.serverIdentity, target: record.target,
                                   operationID: record.operation.operationID,
                                   disposition: .rejectedNoWrite)
        } catch { }
        files.failRemovePath = try XCTUnwrap(files.paths.first(where: {
            $0.hasSuffix(".nmcr") && $0.contains(recoveryPartition(foreign))
        }))
        do {
            try await store.remove(serverIdentity: foreign.serverIdentity, target: foreign.target,
                                   operationID: foreign.operation.operationID,
                                   disposition: .rejectedNoWrite)
        } catch { }
        files.failRemovePath = nil

        let sourceMarkerPath = terminalCleanupPath(root: root, record: record)
        let foreignMarkerPath = terminalCleanupPath(root: root, record: foreign)
        let sourceMarker = try XCTUnwrap(files.value(at: sourceMarkerPath))
        files.replace(sourceMarker, at: foreignMarkerPath)
        let foreignOperationPath = try XCTUnwrap(files.paths.first(where: {
            $0.hasSuffix(".nmcr") && $0.contains(recoveryPartition(foreign))
        }))
        let foreignLocatorPath = try XCTUnwrap(files.paths.first(where: {
            $0.hasSuffix("pending.nmcp") && $0.contains(recoveryPartition(foreign))
        }))
        let operationBytes = try XCTUnwrap(files.value(at: foreignOperationPath))
        let locatorBytes = try XCTUnwrap(files.value(at: foreignLocatorPath))

        do {
            _ = try await store.loadPending(serverIdentity: foreign.serverIdentity, target: foreign.target)
            XCTFail("A marker sealed for another target must fail closed")
        } catch let error as NativeMemoryCorrectionRecoveryError {
            XCTAssertEqual(error, .corruptRecord)
        }
        XCTAssertEqual(files.value(at: foreignOperationPath), operationBytes)
        XCTAssertEqual(files.value(at: foreignLocatorPath), locatorBytes)

        var tamperedSourceMarker = sourceMarker
        tamperedSourceMarker[tamperedSourceMarker.count - 1] ^= 0xff
        files.replace(tamperedSourceMarker, at: sourceMarkerPath)
        do {
            _ = try await store.loadPending(serverIdentity: record.serverIdentity, target: record.target)
            XCTFail("A tampered terminal marker cannot be treated as authority")
        } catch let error as NativeMemoryCorrectionRecoveryError {
            XCTAssertEqual(error, .corruptRecord)
        }
        XCTAssertNotNil(files.value(at: terminalCleanupPath(root: root, record: record)))
        let retainedForeignRecord = try await store.load(serverIdentity: foreign.serverIdentity, target: foreign.target,
                                                         operationID: foreign.operation.operationID)
        XCTAssertEqual(retainedForeignRecord, foreign)
    }

    func testRemovalRequiresExactOperationAndCannotClearNewerDifferentOperation() async throws {
        let files = RecoveryMemoryFiles()
        let store = try makeStore(files: files, vault: RecoveryMemoryVault())
        let oldA = fixture(operationID: "server-op-A")
        let newerB = fixture(operationID: "server-op-B", draft: "New wording B")
        let otherOwner = fixture(operationID: "server-op-A", draft: "Other owner's wording", ownerID: "owner-2")
        try await store.saveBeforeDispatch(oldA)
        do {
            try await store.saveBeforeDispatch(newerB)
            XCTFail("A different pending operation for the same target must not be installed")
        } catch let error as NativeMemoryCorrectionRecoveryError {
            XCTAssertEqual(error, .operationConflict)
        }
        try await store.saveBeforeDispatch(otherOwner)

        try await store.remove(serverIdentity: oldA.serverIdentity, target: oldA.target,
                               operationID: oldA.operation.operationID,
                               disposition: .rejectedNoWrite)
        let removedOldA = try await store.load(serverIdentity: oldA.serverIdentity, target: oldA.target,
                                               operationID: oldA.operation.operationID)
        let recoveredNewerB = try await store.load(serverIdentity: newerB.serverIdentity, target: newerB.target,
                                                   operationID: newerB.operation.operationID)
        let recoveredOtherOwner = try await store.load(serverIdentity: otherOwner.serverIdentity,
                                                       target: otherOwner.target,
                                                       operationID: otherOwner.operation.operationID)
        XCTAssertNil(removedOldA)
        XCTAssertNil(recoveredNewerB)
        XCTAssertEqual(recoveredOtherOwner, otherOwner)
        try await store.saveBeforeDispatch(newerB)
        let discoveredNewerB = try await store.loadPending(serverIdentity: newerB.serverIdentity, target: newerB.target)
        XCTAssertEqual(discoveredNewerB, newerB)
    }

    func testSameOperationCannotBeSilentlyChangedOrOverwritten() async throws {
        let files = RecoveryMemoryFiles()
        let store = try makeStore(files: files, vault: RecoveryMemoryVault())
        let original = fixture()
        try await store.saveBeforeDispatch(original)
        do {
            try await store.saveBeforeDispatch(fixture(draft: "different body for the same operation"))
            XCTFail("A server operation ID cannot acquire a second body")
        } catch let error as NativeMemoryCorrectionRecoveryError {
            XCTAssertEqual(error, .operationConflict)
        }
        let recovered = try await store.load(serverIdentity: original.serverIdentity, target: original.target,
                                             operationID: original.operation.operationID)
        XCTAssertEqual(recovered, original)
    }

    func testIndependentStoreActorsCannotReplaceSameOperationConcurrently() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let files = RecoveryMemoryFiles()
        let vault = RecoveryMemoryVault()
        let firstStore = try makeStore(files: files, vault: vault, root: root)
        let secondStore = try makeStore(files: files, vault: vault, root: root)
        let first = fixture(operationID: "shared-server-operation", draft: "First authorized body")
        let second = fixture(operationID: "shared-server-operation", draft: "Second unauthorized body")
        async let firstResult = captureSave(firstStore, first, isFirst: true)
        async let secondResult = captureSave(secondStore, second, isFirst: false)
        let outcomes = await (firstResult, secondResult)
        let exactlyFirstWon = outcomes.0 == .firstStored && outcomes.1 == .secondConflict
        let exactlySecondWon = outcomes.0 == .firstConflict && outcomes.1 == .secondStored
        XCTAssertTrue(exactlyFirstWon || exactlySecondWon)
        let firstWon = exactlyFirstWon
        let winner = firstWon ? first : second
        let loser = firstWon ? second : first
        let recovered = try await secondStore.load(serverIdentity: winner.serverIdentity, target: winner.target,
                                                   operationID: winner.operation.operationID)
        XCTAssertEqual(recovered, winner)
        do {
            try await firstStore.saveBeforeDispatch(loser)
            XCTFail("A later retry must not replace the atomically installed operation")
        } catch let error as NativeMemoryCorrectionRecoveryError {
            XCTAssertEqual(error, .operationConflict)
        }
        let stillWinner = try await firstStore.load(serverIdentity: winner.serverIdentity, target: winner.target,
                                                    operationID: winner.operation.operationID)
        XCTAssertEqual(stillWinner, winner)
    }

    func testSameOperationSamePayloadIsIdempotentAcrossStoreActors() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let files = RecoveryMemoryFiles()
        let vault = RecoveryMemoryVault()
        let firstStore = try makeStore(files: files, vault: vault, root: root)
        let secondStore = try makeStore(files: files, vault: vault, root: root)
        let record = fixture(operationID: "idempotent-operation")
        async let firstResult = captureSave(firstStore, record, isFirst: true)
        async let secondResult = captureSave(secondStore, record, isFirst: false)
        let outcomes = await (firstResult, secondResult)
        XCTAssertEqual(outcomes.0, .firstStored)
        XCTAssertEqual(outcomes.1, .secondStored)
        XCTAssertEqual(files.values.count, 2) // Immutable operation plus encrypted pending locator.
        let recovered = try await secondStore.load(serverIdentity: record.serverIdentity, target: record.target,
                                                   operationID: record.operation.operationID)
        XCTAssertEqual(recovered, record)
    }

    func testProtectedFileAdapterUsesAtomicNoReplaceOnOwnedTemporaryFiles() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let destination = root.appendingPathComponent("partition").appendingPathComponent("operation.nmcr")
        let firstAdapter = ProtectedNativeMemoryCorrectionRecoveryFileAccess()
        let secondAdapter = ProtectedNativeMemoryCorrectionRecoveryFileAccess()
        let first = Data(repeating: 0xa1, count: 256 * 1024)
        let second = Data(repeating: 0xb2, count: 256 * 1024)

        async let firstInstalled = Task.detached {
            try firstAdapter.installAtomicallyIfAbsent(first, to: destination)
        }.value
        async let secondInstalled = Task.detached {
            try secondAdapter.installAtomicallyIfAbsent(second, to: destination)
        }.value
        let outcomes = try await (firstInstalled, secondInstalled)
        XCTAssertNotEqual(outcomes.0, outcomes.1)
        let retained = try firstAdapter.read(destination, maximumBytes: 512 * 1024)
        XCTAssertTrue(retained == first || retained == second)
        XCTAssertTrue(FileManager.default.fileExists(atPath: destination.path))
    }

    func testCorruptAndUnknownVersionRecordsFailClosedAndRemainForEvidence() async throws {
        for unknownVersion in [false, true] {
            let files = RecoveryMemoryFiles()
            let store = try makeStore(files: files, vault: RecoveryMemoryVault())
            let record = fixture()
            try await store.saveBeforeDispatch(record)
            let path = try XCTUnwrap(files.paths.first(where: { $0.hasSuffix(".nmcr") }))
            var bytes = try XCTUnwrap(files.value(at: path))
            if unknownVersion {
                bytes.replaceSubrange(4..<5, with: [0x02])
            } else {
                bytes[bytes.count - 1] ^= 0xff
            }
            files.replace(bytes, at: path)
            do {
                try await store.saveBeforeDispatch(record)
                XCTFail("A corrupt or unknown operation file must never be replaced")
            } catch { }
            XCTAssertEqual(files.value(at: path), bytes)
            do {
                _ = try await store.load(serverIdentity: record.serverIdentity, target: record.target,
                                         operationID: record.operation.operationID)
                XCTFail("Corrupt and unknown formats must not be interpreted as empty")
            } catch let error as NativeMemoryCorrectionRecoveryError {
                XCTAssertEqual(error, unknownVersion ? .unsupportedVersion : .corruptRecord)
            }
            do {
                try await store.remove(serverIdentity: record.serverIdentity, target: record.target,
                                       operationID: record.operation.operationID,
                                       disposition: .savedWithOperationBoundReadback)
                XCTFail("A failed integrity check must preserve the evidence")
            } catch { }
            XCTAssertNotNil(files.value(at: path))
        }
    }

    func testFailedAtomicWriteDoesNotCreateAReadableOperation() async throws {
        let files = RecoveryMemoryFiles()
        let store = try makeStore(files: files, vault: RecoveryMemoryVault())
        let record = fixture()
        files.failWrites = true
        do {
            try await store.saveBeforeDispatch(record)
            XCTFail("Storage failure must block dispatch")
        } catch { }
        files.failWrites = false
        let recovered = try await store.load(serverIdentity: record.serverIdentity, target: record.target,
                                             operationID: record.operation.operationID)
        XCTAssertNil(recovered)
        XCTAssertTrue(files.values.isEmpty)
    }

    func testRawBearerCannotBeStoredAsAuthorizationHandle() async throws {
        let store = try makeStore(files: RecoveryMemoryFiles(), vault: RecoveryMemoryVault())
        let record = NativeMemoryCorrectionRecoveryRecord(
            serverIdentity: "https://assistant.example/deployment/base",
            target: .init(ownerID: "owner-1", serverID: "production-west", memoryID: "memory-1", sourceIdentity: "source-1"),
            operation: .init(operationID: "server-operation-1", expectedRevision: "revision-1", expectedStoredContentHash: nil),
            snapshot: .init(revision: "revision-1", storedContentHash: nil,
                            content: "Original saved wording", sourceLabel: "Imported note",
                            ownerCorrected: false, readOnlyReason: nil),
            draft: "A reviewed correction draft",
            authorizationHandle: "never-persist-this-bearer"
        )
        do {
            try await store.saveBeforeDispatch(record)
            XCTFail("Only the purpose-bound server authorization handle may be stored")
        } catch let error as NativeMemoryCorrectionRecoveryError {
            XCTAssertEqual(error, .invalidRecord)
        }
    }

    func testOwnerServerTargetAndSourceIdentityAreBoundIndependently() async throws {
        let files = RecoveryMemoryFiles()
        let vault = RecoveryMemoryVault()
        let store = try makeStore(files: files, vault: vault)
        let record = fixture()
        try await store.saveBeforeDispatch(record)
        let variants = [
            NativeMemoryCorrectionRecoveryRecord.Target(ownerID: "owner-b", serverID: record.target.serverID,
                memoryID: record.target.memoryID, sourceIdentity: record.target.sourceIdentity),
            NativeMemoryCorrectionRecoveryRecord.Target(ownerID: record.target.ownerID, serverID: record.target.serverID,
                memoryID: "memory-b", sourceIdentity: record.target.sourceIdentity),
            NativeMemoryCorrectionRecoveryRecord.Target(ownerID: record.target.ownerID, serverID: record.target.serverID,
                memoryID: record.target.memoryID, sourceIdentity: "source-b"),
        ]
        for target in variants {
            let foreign = try await store.load(serverIdentity: record.serverIdentity, target: target,
                                               operationID: record.operation.operationID)
            XCTAssertNil(foreign)
        }
        let recovered = try await store.load(serverIdentity: record.serverIdentity, target: record.target,
                                             operationID: record.operation.operationID)
        XCTAssertEqual(recovered, record)
    }

    private enum ConcurrentSaveResult: Hashable {
        case firstStored
        case secondStored
        case firstConflict
        case secondConflict
        case firstFailure
        case secondFailure
    }

    private func captureSave(
        _ store: NativeMemoryCorrectionRecoveryStore,
        _ record: NativeMemoryCorrectionRecoveryRecord,
        isFirst: Bool
    ) async -> ConcurrentSaveResult {
        do {
            try await store.saveBeforeDispatch(record)
            return isFirst ? .firstStored : .secondStored
        } catch let error as NativeMemoryCorrectionRecoveryError where error == .operationConflict {
            return isFirst ? .firstConflict : .secondConflict
        } catch {
            return isFirst ? .firstFailure : .secondFailure
        }
    }

    private func makeStore(
        files: RecoveryMemoryFiles,
        vault: RecoveryMemoryVault,
        root: URL? = nil
    ) throws -> NativeMemoryCorrectionRecoveryStore {
        try NativeMemoryCorrectionRecoveryStore(
            applicationSupportRoot: root ?? FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString),
            keyVault: vault,
            files: files
        )
    }

    private func fixture(
        operationID: String = "server-issued-operation-1",
        draft: String = "A reviewed correction draft",
        ownerID: String = "owner-1",
        memoryID: String = "memory-1",
        authorizationExpiresAt: String? = nil
    ) -> NativeMemoryCorrectionRecoveryRecord {
        NativeMemoryCorrectionRecoveryRecord(
            serverIdentity: "https://assistant.example/deployment/base",
            target: .init(ownerID: ownerID, serverID: "production-west", memoryID: memoryID, sourceIdentity: "source-1"),
            operation: .init(operationID: operationID, expectedRevision: "source-revision-7",
                             expectedStoredContentHash: String(repeating: "a", count: 64)),
            snapshot: .init(revision: "source-revision-7", storedContentHash: String(repeating: "a", count: 64),
                            content: "Original saved wording", sourceLabel: "Imported note",
                            ownerCorrected: true, readOnlyReason: nil),
            draft: draft,
            authorizationHandle: "omc1.c2VydmVyLWlzc3VlZC1jbGFpbXM.c2lnbmF0dXJl",
            authorizationExpiresAt: authorizationExpiresAt
        )
    }

    private func recoveryPartition(_ record: NativeMemoryCorrectionRecoveryRecord) -> String {
        let fields = ["native-memory-correction-partition-v1", record.serverIdentity,
                      record.target.ownerID, record.target.serverID, record.target.memoryID,
                      record.target.sourceIdentity ?? ""]
        var tuple = Data()
        for field in fields {
            let bytes = Data(field.utf8)
            var length = UInt64(bytes.count).bigEndian
            withUnsafeBytes(of: &length) { tuple.append(contentsOf: $0) }
            tuple.append(bytes)
        }
        return SHA256.hash(data: tuple).map { String(format: "%02x", $0) }.joined()
    }

    private func terminalCleanupPath(root: URL, record: NativeMemoryCorrectionRecoveryRecord) -> String {
        root.appendingPathComponent("NativeMemoryCorrectionRecovery", isDirectory: true)
            .appendingPathComponent(recoveryPartition(record), isDirectory: true)
            .appendingPathComponent("terminal-cleanup.nmct").path
    }
}

private final class RecoveryMemoryVault: CardFormDraftKeyVault, @unchecked Sendable {
    private let lock = NSLock()
    private var keys: [String: SymmetricKey] = [:]
    private var closed = Set<String>()

    func assertOpen(partition: String) throws {
        try lock.withLock {
            if closed.contains(partition) { throw EncryptedCardFormDraftStorageError.partitionClosed }
        }
    }

    func key(for partition: String, createIfMissing: Bool) throws -> SymmetricKey {
        try lock.withLock {
            if closed.contains(partition) { throw EncryptedCardFormDraftStorageError.partitionClosed }
            if let key = keys[partition] { return key }
            guard createIfMissing else { throw EncryptedCardFormDraftStorageError.keyUnavailable }
            let key = SymmetricKey(size: .bits256)
            keys[partition] = key
            return key
        }
    }

    func close(partition: String) throws {
        lock.withLock {
            keys.removeValue(forKey: partition)
            closed.insert(partition)
        }
    }
}

private final class RecoveryMemoryFiles: NativeMemoryCorrectionRecoveryFileAccess, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: Data] = [:]
    var failWrites = false
    var failPendingLocatorWrites = false
    var failRemovePath: String?

    var values: [Data] { lock.withLock { Array(storage.values) } }
    var paths: [String] { lock.withLock { Array(storage.keys) } }
    var onlyValue: Data? { lock.withLock { storage.count == 1 ? storage.values.first : nil } }
    var onlyPath: String? { lock.withLock { storage.count == 1 ? storage.keys.first : nil } }
    func value(at path: String) -> Data? { lock.withLock { storage[path] } }
    func replace(_ data: Data, at path: String) { lock.withLock { storage[path] = data } }
    func exists(_ url: URL) -> Bool { lock.withLock { storage[url.path] != nil } }

    func read(_ url: URL, maximumBytes: Int) throws -> Data {
        try lock.withLock {
            guard let data = storage[url.path], data.count <= maximumBytes else {
                throw NativeMemoryCorrectionRecoveryError.corruptRecord
            }
            return data
        }
    }

    func writeAtomically(_ data: Data, to url: URL) throws {
        try lock.withLock {
            if failWrites { throw EncryptedCardFormDraftStorageError.writeFailed }
            storage[url.path] = data
        }
    }

    func installAtomicallyIfAbsent(_ data: Data, to url: URL) throws -> Bool {
        try lock.withLock {
            if failPendingLocatorWrites && url.lastPathComponent == "pending.nmcp" {
                throw EncryptedCardFormDraftStorageError.writeFailed
            }
            if failWrites { throw EncryptedCardFormDraftStorageError.writeFailed }
            guard storage[url.path] == nil else { return false }
            storage[url.path] = data
            return true
        }
    }

    func removeFile(_ url: URL) throws {
        try lock.withLock {
            if failRemovePath == url.path { throw EncryptedCardFormDraftStorageError.writeFailed }
            storage.removeValue(forKey: url.path)
        }
    }
    func removePartition(_ url: URL) throws {
        lock.withLock { storage = storage.filter { !$0.key.hasPrefix(url.path + "/") } }
    }
}
