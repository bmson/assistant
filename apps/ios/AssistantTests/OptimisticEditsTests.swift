import CryptoKit
import Observation
import XCTest
@testable import Assistant

@MainActor
final class OptimisticEditsTests: XCTestCase {
    private func row(_ title: String) -> Commitment {
        Commitment(id: "loop", kind: "question", title: title, details: "", nextAction: "", dueAt: nil, status: "open")
    }

    func testSettingsEditsDoNotInvalidateTheConversationOverview() async {
        let store = OptimisticEditStore()
        let invalidations = ObservationProbe()
        withObservationTracking { _ = store.visible.overview } onChange: { invalidations.increment() }
        store.reconcile = { _ in true }
        store.submit(title: "Settings", resources: [.workspace], patch: { _ in }) {}
        await store.settle()
        XCTAssertEqual(invalidations.count, 0)
    }

    func testFailureAfterASuccessRollsBackToTheAcknowledgedValue() async {
        let store = OptimisticEditStore()
        store.updateRemote { $0.commitments = [row("Original")] }
        store.reconcile = { _ in false }
        store.submit(title: "First", resources: [.commitments], patch: { $0.commitments?[0].title = "Acknowledged" }) {}
        store.submit(title: "Second", resources: [.commitments], patch: { $0.commitments?[0].title = "Rejected" }) {
            throw APIError.server(status: 400, message: "No")
        }
        await store.settle()
        XCTAssertEqual(store.visible.commitments?.first?.title, "Acknowledged")
        XCTAssertEqual(store.serverSnapshot.commitments?.first?.title, "Acknowledged")
    }

    func testAcceptanceIsUnder200msWithASlowWriteAndRefresh() async throws {
        let store = OptimisticEditStore()
        store.updateRemote { $0.commitments = [row("Original")] }
        var didWrite = false
        store.reconcile = { _ in
            try? await Task.sleep(for: .milliseconds(250))
            store.updateRemote { $0.commitments = [self.row("Changed")] }
            return true
        }
        let started = ContinuousClock.now
        store.submit(title: "Loop", resources: [.commitments], patch: { $0.commitments?[0].title = "Changed" }) {
            try await Task.sleep(for: .milliseconds(350))
            didWrite = true
        }
        XCTAssertLessThan(ContinuousClock.now - started, .milliseconds(200))
        XCTAssertEqual(store.visible.commitments?.first?.title, "Changed")
        XCTAssertFalse(didWrite, "Rendering an edit must not depend on starting a request")
        XCTAssertEqual(store.pendingCount, 1)
        await store.settle()
        XCTAssertTrue(didWrite)
        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertFalse(store.needsRefresh)
        XCTAssertEqual(store.visible.commitments?.first?.title, "Changed")
    }

    func testUnknownMemoryWriteRequiresReviewBeforeErasure() async throws {
        let store = OptimisticEditStore()
        store.submit(title: "Memory", resources: [.memory], retrySafe: false, patch: { _ in }) {
            throw APIError.transport(URLError(.timedOut))
        }
        await store.settle()
        XCTAssertTrue(store.hasUnknownWrite(in: [.memory]))
        XCTAssertFalse(store.hasUnknownWrite(in: [.providers]))
        store.dismissFailure(try XCTUnwrap(store.failures.first?.id))
        XCTAssertFalse(store.hasUnknownWrite(in: [.memory]))
        store.submit(title: "Invalid memory", resources: [.memory], patch: { _ in }) {
            throw APIError.server(status: 400, message: "Invalid")
        }
        await store.settle()
        XCTAssertFalse(store.hasUnknownWrite(in: [.memory]), "A definitive validation rejection cannot still commit")
    }

    func testPollingRebasesUnderAPendingEdit() async {
        let store = OptimisticEditStore()
        store.updateRemote { $0.commitments = [row("Original")] }
        store.submit(title: "Loop", resources: [.commitments], patch: { $0.commitments?[0].title = "Latest edit" }) {
            try await Task.sleep(for: .milliseconds(30))
            throw APIError.server(status: 400, message: "Rejected")
        }
        store.updateRemote { $0.commitments = [row("New server snapshot")] }
        XCTAssertEqual(store.visible.commitments?.first?.title, "Latest edit")
        await store.settle()
        XCTAssertEqual(store.visible.commitments?.first?.title, "New server snapshot", "Failure rolls back onto the latest server value")
        XCTAssertEqual(store.failures.count, 1)
    }

    func testOlderFailureCannotRollBackANewerEditAndWritesStayOrdered() async {
        let store = OptimisticEditStore()
        store.updateRemote { $0.commitments = [row("Original")] }
        var order: [Int] = []
        store.reconcile = { _ in
            store.updateRemote { $0.commitments = [self.row("Second")] }
            return true
        }
        store.submit(title: "First", resources: [.commitments], patch: { $0.commitments?[0].title = "First" }) {
            order.append(1)
            try await Task.sleep(for: .milliseconds(30))
            throw APIError.server(status: 400, message: "Rejected")
        }
        store.submit(title: "Second", resources: [.commitments], patch: { $0.commitments?[0].title = "Second" }) {
            order.append(2)
        }
        XCTAssertEqual(store.visible.commitments?.first?.title, "Second")
        await store.settle()
        XCTAssertEqual(order, [1, 2])
        XCTAssertEqual(store.visible.commitments?.first?.title, "Second")
        XCTAssertEqual(store.failures.map(\.title), ["First"])
    }

    func testFailedRefreshKeepsConfirmedEditAndNeverRepeatsTheWrite() async {
        let store = OptimisticEditStore()
        store.updateRemote { $0.commitments = [row("Original")] }
        var writes = 0
        var reads = 0
        store.reconcile = { _ in
            reads += 1
            store.updateRemote { $0.commitments = [self.row("Stale")] }
            return false
        }
        store.submit(title: "Loop", resources: [.commitments], patch: { $0.commitments?[0].title = "Saved" }) { writes += 1 }
        await store.settle()
        XCTAssertEqual(writes, 1)
        XCTAssertEqual(store.visible.commitments?.first?.title, "Saved")
        XCTAssertTrue(store.needsRefresh)
        XCTAssertTrue(store.failures.isEmpty)
        store.refreshConfirmed()
        await store.settle()
        XCTAssertEqual(writes, 1)
        XCTAssertEqual(reads, 2)
        store.reconcile = { _ in
            store.updateRemote { $0.commitments = [self.row("Saved")] }
            return true
        }
        store.refreshConfirmed()
        await store.settle()
        XCTAssertFalse(store.needsRefresh)
        XCTAssertEqual(writes, 1)
    }

    func testRetryRetainsTheSubmittedDraft() async throws {
        let store = OptimisticEditStore()
        store.updateRemote { $0.commitments = [row("Original")] }
        var writes = 0
        store.reconcile = { _ in store.updateRemote { $0.commitments = [self.row("Draft")] }; return true }
        store.submit(title: "Loop", draft: "Draft", resources: [.commitments], patch: { $0.commitments?[0].title = "Draft" }) {
            writes += 1
            if writes == 1 { throw APIError.transport(URLError(.notConnectedToInternet)) }
        }
        await store.settle()
        let failure = try XCTUnwrap(store.failures.first)
        XCTAssertEqual(failure.draft, "Draft")
        XCTAssertEqual(store.visible.commitments?.first?.title, "Original")
        store.retry(failure.id)
        XCTAssertEqual(store.visible.commitments?.first?.title, "Draft")
        await store.settle()
        XCTAssertEqual(writes, 2)
        XCTAssertTrue(store.failures.isEmpty)
    }

    func testAmbiguousCreateCannotBeBlindlyRetried() async throws {
        let store = OptimisticEditStore()
        var attempts = 0
        store.submit(title: "New person", draft: "Robin", resources: [.people], retrySafe: false, patch: { _ in }) {
            attempts += 1
            throw APIError.transport(URLError(.networkConnectionLost))
        }
        await store.settle()
        let failure = try XCTUnwrap(store.failures.first)
        XCTAssertFalse(failure.canRetry)
        store.retry(failure.id)
        await store.settle()
        XCTAssertEqual(attempts, 1)
        XCTAssertEqual(store.failures.first?.draft, "Robin")
    }

    func testConnectionResetIgnoresALateWriteCompletion() async {
        let store = OptimisticEditStore()
        store.updateRemote { $0.commitments = [row("Old owner")] }
        store.submit(title: "Loop", resources: [.commitments], patch: { $0.commitments?[0].title = "Old edit" }) {
            try? await Task.sleep(for: .milliseconds(70))
        }
        await Task.yield()
        store.reset()
        store.updateRemote { $0.commitments = [row("New owner")] }
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(store.visible.commitments?.first?.title, "New owner")
        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertTrue(store.failures.isEmpty)
    }

    func testBatchPublishesReconciledSnapshotsAtomically() async {
        let store = OptimisticEditStore()
        store.updateRemote { $0.commitments = [row("Original")] }
        store.reconcile = { _ in
            store.updateRemote { $0.commitments = [self.row("Server normalized")] }
            XCTAssertEqual(store.visible.commitments?.first?.title, "Edit")
            await Task.yield()
            return true
        }
        store.submit(title: "Loop", resources: [.commitments], patch: { $0.commitments?[0].title = "Edit" }) {}
        await store.settle()
        XCTAssertEqual(store.visible.commitments?.first?.title, "Server normalized")
    }

    func testUnrelatedLocalActionsPublishWhileReconciliationIsPending() async {
        let store = OptimisticEditStore()
        store.updateRemote { $0.commitments = [row("Original")] }
        store.reconcile = { _ in
            store.updateRemote { $0.commitments = [self.row("Normalized")] }
            store.updateRemote(resources: [.commitments], immediate: true) { $0.commitments?.append(self.row("Immediate action")) }
            XCTAssertEqual(store.visible.commitments?.count, 2, "A local action cannot wait behind background GETs")
            return true
        }
        store.submit(title: "Loop", resources: [.commitments], patch: { $0.commitments?[0].title = "Edit" }) {}
        await store.settle()
        XCTAssertEqual(store.visible.commitments?.map(\.title), ["Normalized", "Immediate action"])
    }

    func testUnrelatedPageReadDoesNotWaitForAnotherPagesReconciliation() async {
        let store = OptimisticEditStore()
        store.updateRemote { $0.commitments = [row("Original")] }
        store.reconcile = { _ in
            store.updateRemote(resources: [.providers]) {
                $0.modelProviders = ModelProviderSettings(connections: [], models: [], mainModel: "loaded", fastModel: nil, voiceModel: nil, voicePresets: [])
            }
            XCTAssertEqual(store.visible.modelProviders?.mainModel, "loaded", "Opening Providers cannot wait on an unrelated save refresh")
            store.updateRemote(resources: [.commitments]) { $0.commitments = [self.row("Saved")] }
            return true
        }
        store.submit(title: "Loop", resources: [.commitments], patch: { $0.commitments?[0].title = "Edit" }) {}
        await store.settle()
        XCTAssertEqual(store.visible.modelProviders?.mainModel, "loaded")
        XCTAssertEqual(store.visible.commitments?.first?.title, "Saved")
    }

    func testRecoveryIsEncryptedScopedAndRemovedOnConfirmation() async throws {
        let scope = "https://recovery.test|owner-" + UUID().uuidString
        let journal = MobileEditRecoveryJournal(scope: scope)
        let record = MobileEditRecoveryRecord(id: UUID(), title: "Memory", draft: "Private submitted wording")
        try await journal.save(record)
        let recovered = try await MobileEditRecoveryJournal(scope: scope).load()
        XCTAssertEqual(recovered.first?.draft, record.draft)
        let otherOwner = try await MobileEditRecoveryJournal(scope: scope + "-other").load()
        XCTAssertTrue(otherOwner.isEmpty)
        let digest = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
        let file = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("MobileEditRecovery/" + digest + ".sealed")
        let encrypted = try Data(contentsOf: file)
        XCTAssertNil(encrypted.range(of: Data(record.draft.utf8)))
        try await journal.remove(record.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    func testHundredRapidEditsKeepLatestIntentUnder200ms() async {
        let store = OptimisticEditStore()
        store.updateRemote { $0.commitments = [row("Original")] }
        store.reconcile = { _ in store.updateRemote { $0.commitments = [self.row("99")] }; return true }
        var latencies: [Duration] = []
        for index in 0..<100 {
            let title = String(index)
            let started = ContinuousClock.now
            store.submit(title: title, resources: [.commitments], patch: { $0.commitments?[0].title = title }) {}
            latencies.append(ContinuousClock.now - started)
        }
        XCTAssertEqual(store.visible.commitments?.first?.title, "99")
        XCTAssertLessThan(try! XCTUnwrap(latencies.max()), .milliseconds(200))
        print("Optimistic edit acceptance worst of 100: \(latencies.max()!)")
        await store.settle()
        XCTAssertEqual(store.visible.commitments?.first?.title, "99")
    }
}

private final class ObservationProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var count: Int { lock.withLock { value } }
    func increment() { lock.withLock { value += 1 } }
}
