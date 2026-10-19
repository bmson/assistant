import CryptoKit
import Foundation
import Observation

/// Server snapshots stay separate from pending edits. Every refresh is rebased
/// under the edits, so polling cannot flash an old value over a just-saved one.
struct MobileScreenState {
    var workspace: WorkspaceResponse?
    var overview: OverviewResponse?
    var archivedGoals: GoalsDashboard?
    var people: [PersonSummary] = []
    var personProfiles: [String: PersonProfileResponse] = [:]
    var personCards: [String: PersonCard] = [:]
    var modelProviders: ModelProviderSettings?
    var savedCards: [SavedCardRecord] = []
    var commitments: [Commitment]?
    var memoryLibraries: [MemoryLibraryQuery: MemoryLibraryResponse] = [:]
    var voiceProfile: VoiceProfileResponse?
}

@MainActor
@Observable
final class MobileScreenProjection {
    var workspace: WorkspaceResponse?
    var overview: OverviewResponse?
    var archivedGoals: GoalsDashboard?
    var people: [PersonSummary] = []
    var personProfiles: [String: PersonProfileResponse] = [:]
    var personCards: [String: PersonCard] = [:]
    var modelProviders: ModelProviderSettings?
    var savedCards: [SavedCardRecord] = []
    var commitments: [Commitment]?
    var memoryLibraries: [MemoryLibraryQuery: MemoryLibraryResponse] = [:]
    var voiceProfile: VoiceProfileResponse?
}

enum MobileEditResource: Hashable {
    case memory, workspace, overview, archivedGoals, people, personCaches, person(String), commitments, providers, cards, library(MemoryLibraryQuery), voiceProfile
}

@MainActor
@Observable
final class OptimisticEditStore {
    typealias Patch = @MainActor (inout MobileScreenState) -> Void
    typealias Write = @MainActor () async throws -> Void
    typealias Reconcile = @MainActor (Set<MobileEditResource>) async -> Bool

    struct Failure: Identifiable {
        let id: UUID
        let title: String
        let message: String
        let draft: String
        /// Transport failures can mean the server committed the write. A
        /// non-idempotent create must never offer a blind resubmission.
        let canRetry: Bool
        var outcomeUnknown = false
    }

    private enum Phase { case queued, saving, confirmed, failed }
    private struct Edit {
        let id: UUID
        let title: String
        let resources: Set<MobileEditResource>
        let patch: Patch
        let write: Write
        let retrySafe: Bool
        let draft: String
        var phase: Phase = .queued
        var failure: Failure?
    }

    let visible = MobileScreenProjection()
    private(set) var failures: [Failure] = []
    private(set) var pendingCount = 0
    private(set) var needsRefresh = false
    private(set) var revision = 0
    @ObservationIgnored private var resourceRevisions: [MobileEditResource: Int] = [:]
    @ObservationIgnored private var resetRevision = 0
    @ObservationIgnored private var remote = MobileScreenState()
    @ObservationIgnored private var stagedRemote: MobileScreenState?
    @ObservationIgnored private var stagingResources: Set<MobileEditResource> = []
    @ObservationIgnored private var entries: [Edit] = []
    @ObservationIgnored private var worker: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var journal: MobileEditRecoveryJournal?
    @ObservationIgnored private var recoveryScope: String?
    @ObservationIgnored private var recoveryCleanup: Task<Void, Never>?
    @ObservationIgnored var reconcile: Reconcile?
    @ObservationIgnored var recoveryJournalFactory: (String) -> MobileEditRecoveryJournal = { MobileEditRecoveryJournal(scope: $0) }

    func configureRecovery(scope: String) {
        guard recoveryScope != scope else { return }
        recoveryScope = scope
        let journal = recoveryJournalFactory(scope)
        self.journal = journal
        let epoch = generation
        let cleanup = recoveryCleanup
        Task { [weak self] in
            do {
                await cleanup?.value
                let records = try await journal.load()
                guard let self, self.generation == epoch, self.recoveryScope == scope else { return }
                for record in records where !self.entries.contains(where: { $0.id == record.id }) {
                    var edit = Edit(id: record.id, title: record.title, resources: record.memoryRelated == true ? [.memory] : [], patch: { _ in },
                                    write: {}, retrySafe: false, draft: record.draft)
                    edit.phase = .failed
                    edit.failure = Failure(id: record.id, title: record.title,
                        message: "This save was interrupted. Check the current information before submitting it again.",
                        draft: record.draft, canRetry: false, outcomeUnknown: true)
                    self.entries.append(edit)
                }
                self.rebuild()
            } catch {
                guard let self, self.generation == epoch, self.recoveryScope == scope else { return }
                // Keep the encrypted record intact if the device is locked.
                let id = UUID()
                var edit = Edit(id: id, title: "Saved changes need review", resources: [], patch: { _ in },
                                write: {}, retrySafe: false, draft: "")
                edit.phase = .failed
                edit.failure = Failure(id: id, title: edit.title,
                    message: "Unlock your device and reopen the app to review interrupted saves.", draft: "", canRetry: false)
                self.entries.append(edit)
                self.rebuild()
            }
        }
    }

    var serverSnapshot: MobileScreenState { remote }

    /// An unrelated edit cannot invalidate a page's in-flight read.
    func revision(for resources: Set<MobileEditResource>) -> Int {
        resources.reduce(resetRevision) { max($0, resourceRevisions[$1, default: resetRevision]) }
    }

    private func advanceRevision(resources: Set<MobileEditResource>) {
        revision += 1
        for resource in resources { resourceRevisions[resource] = revision }
    }

    func invalidateReads(for resources: Set<MobileEditResource>) {
        advanceRevision(resources: resources)
    }

    func updateRemote(resources: Set<MobileEditResource>? = nil, immediate: Bool = false, _ update: (inout MobileScreenState) -> Void) {
        if var staged = stagedRemote {
            update(&staged)
            stagedRemote = staged
            if immediate || resources?.isDisjoint(with: stagingResources) == true {
                update(&remote)
                rebuild(resources: resources)
            }
        } else {
            update(&remote)
            rebuild(resources: resources)
        }
    }

    /// Returns on the current main-actor turn, before starting network work.
    func submit(title: String, draft: String = "", resources: Set<MobileEditResource>, retrySafe: Bool = true,
                patch: @escaping Patch, write: @escaping Write) {
        entries.append(Edit(id: UUID(), title: title, resources: resources,
                            patch: patch, write: write, retrySafe: retrySafe, draft: draft))
        advanceRevision(resources: resources)
        rebuild(resources: resources)
        startWorker()
    }

    func retry(_ id: UUID) {
        guard let index = entries.firstIndex(where: { $0.id == id }),
              entries[index].failure?.canRetry == true else { return }
        var edit = entries.remove(at: index)
        edit.phase = .queued
        edit.failure = nil
        // An explicit retry is the owner's newest intent for this record.
        entries.append(edit)
        advanceRevision(resources: edit.resources)
        rebuild(resources: edit.resources)
        startWorker()
    }

    func dismissFailure(_ id: UUID) {
        entries.removeAll { $0.id == id && $0.phase == .failed }
        if let journal { Task { try? await journal.remove(id) } }
        rebuild()
    }

    func hasUnknownWrite(in resources: Set<MobileEditResource>) -> Bool {
        entries.contains { !$0.resources.isDisjoint(with: resources) && $0.failure?.outcomeUnknown == true }
    }

    func discardSettled(resources: Set<MobileEditResource>) {
        let removed = entries.filter { !$0.resources.isDisjoint(with: resources) && ($0.phase == .failed || $0.phase == .confirmed) }
        let ids = Set(removed.map(\.id))
        entries.removeAll { ids.contains($0.id) }
        if let journal { Task { for id in ids { try? await journal.remove(id) } } }
        rebuild()
    }

    func refreshConfirmed() { startWorker() }

    func reset() {
        generation = UUID()
        if let journal {
            let previousCleanup = recoveryCleanup
            recoveryCleanup = Task {
                await previousCleanup?.value
                try? await journal.clear()
            }
        }
        journal = nil
        recoveryScope = nil
        worker?.cancel()
        worker = nil
        entries = []
        remote = MobileScreenState()
        stagedRemote = nil
        stagingResources = []
        revision += 1
        resetRevision = revision
        resourceRevisions = [:]
        rebuild()
    }

    private func rebuild(resources: Set<MobileEditResource>? = nil) {
        var state = remote
        for edit in entries where edit.phase != .failed { edit.patch(&state) }
        // Publish only the caches that changed. A Settings write must not
        // invalidate the transcript, People directory or provider pickers.
        if resources == nil || resources!.contains(.workspace) { visible.workspace = state.workspace }
        if resources == nil || resources!.contains(.overview) { visible.overview = state.overview }
        if resources == nil || resources!.contains(.archivedGoals) { visible.archivedGoals = state.archivedGoals }
        if resources == nil || resources!.contains(.people) { visible.people = state.people }
        if resources == nil || resources!.contains(.providers) { visible.modelProviders = state.modelProviders }
        if resources == nil || resources!.contains(.cards) { visible.savedCards = state.savedCards }
        if resources == nil || resources!.contains(.commitments) { visible.commitments = state.commitments }
        if resources == nil || resources!.contains(.voiceProfile) { visible.voiceProfile = state.voiceProfile }
        if resources == nil || resources!.contains(.personCaches) || resources!.contains(where: { if case .person = $0 { return true }; return false }) {
            visible.personProfiles = state.personProfiles
            visible.personCards = state.personCards
        }
        if resources == nil || resources!.contains(where: { if case .library = $0 { return true }; return false }) {
            visible.memoryLibraries = state.memoryLibraries
        }
        failures = entries.compactMap(\.failure)
        pendingCount = entries.filter { $0.phase == .queued || $0.phase == .saving }.count
        needsRefresh = entries.contains { $0.phase == .confirmed }
    }

    private func startWorker() {
        guard worker == nil, entries.contains(where: { $0.phase != .failed }) else { return }
        let epoch = generation
        worker = Task { [weak self] in
            guard let self else { return }
            while self.generation == epoch {
                if let index = self.entries.firstIndex(where: { $0.phase == .queued }) {
                    let edit = self.entries[index]
                    self.entries[index].phase = .saving
                    var dispatched = false
                    do {
                        await self.recoveryCleanup?.value
                        guard self.generation == epoch, !Task.isCancelled else { return }
                        try await self.journal?.save(MobileEditRecoveryRecord(id: edit.id, title: edit.title, draft: edit.draft, memoryRelated: edit.resources.contains(.memory)))
                        guard self.generation == epoch, !Task.isCancelled else { return }
                        dispatched = true
                        try await edit.write()
                        // The write is confirmed even if its subsequent GET
                        // fails. Do not recover it as an unknown write.
                        try? await self.journal?.remove(edit.id)
                        guard self.generation == epoch else { return }
                        if let current = self.entries.firstIndex(where: { $0.id == edit.id }) {
                            // Patches are idempotent assignments/upserts. The
                            // acknowledged intent becomes the rollback baseline
                            // for later edits even if refreshing is unavailable.
                            edit.patch(&self.remote)
                            self.entries[current].phase = .confirmed
                        }
                    } catch {
                        guard self.generation == epoch else { return }
                        if let current = self.entries.firstIndex(where: { $0.id == edit.id }) {
                            self.entries[current].phase = .failed
                            self.entries[current].failure = Failure(
                                id: edit.id, title: edit.title,
                                message: AssistantErrorNotice(error: error).message, draft: edit.draft,
                                canRetry: edit.retrySafe, outcomeUnknown: dispatched && Self.isUnknownOutcome(error))
                        }
                    }
                    self.advanceRevision(resources: edit.resources)
                    self.rebuild(resources: edit.resources)
                    continue
                }
                let confirmed = self.entries.filter { $0.phase == .confirmed }
                guard !confirmed.isEmpty else { break }
                let ids = Set(confirmed.map(\.id))
                let resources = confirmed.reduce(into: Set<MobileEditResource>()) { $0.formUnion($1.resources) }
                self.stagedRemote = self.remote
                self.stagingResources = resources
                if await self.reconcile?(resources) == true {
                    guard self.generation == epoch else { return }
                    self.remote = self.stagedRemote ?? self.remote
                    self.stagedRemote = nil
                    self.stagingResources = []
                    self.entries.removeAll { ids.contains($0.id) }
                    self.rebuild(resources: resources)
                } else {
                    // Keep the confirmed overlay if a follow-up GET failed.
                    // No successful write is ever submitted a second time.
                    guard self.generation == epoch else { return }
                    self.stagedRemote = nil
                    self.stagingResources = []
                    if !self.entries.contains(where: { $0.phase == .queued }) { break }
                }
            }
            guard self.generation == epoch else { return }
            self.worker = nil
        }
    }

    private static func isUnknownOutcome(_ error: Error) -> Bool {
        switch error {
        case APIError.transport, APIError.decoding, APIError.invalidResponse, is CancellationError: return true
        case let APIError.server(status, _): return status >= 500 || status == 408
        default: return false
        }
    }

    /// Test and lifecycle hook: waits for this batch, including reconciliation.
    func settle() async { await worker?.value }
}

/// Recovery stores the submitted wording, never an executable request. A crash
/// during a write has an unknown outcome; relaunch offers review, not replay.
struct MobileEditRecoveryRecord: Codable, Identifiable, Sendable {
    let id: UUID
    let title: String
    let draft: String
    var memoryRelated: Bool? = nil
}

actor MobileEditRecoveryJournal {
    private let partition: String
    private let url: URL
    private let vault: any CardFormDraftKeyVault
    private let files = ProtectedCardFormDraftFileAccess()
    private var records: [MobileEditRecoveryRecord]?

    init(scope: String, keyVault: any CardFormDraftKeyVault = KeychainCardFormDraftKeyVault(),
         applicationSupportRoot: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]) {
        vault = keyVault
        let digest = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
        partition = "mobile-edit-recovery-" + digest
        url = applicationSupportRoot
            .appendingPathComponent("MobileEditRecovery", isDirectory: true)
            .appendingPathComponent(digest + ".sealed")
    }

    func load() throws -> [MobileEditRecoveryRecord] {
        if let records { return records }
        guard files.exists(url) else { records = []; return [] }
        let key = try vault.key(for: partition, createIfMissing: false)
        let box = try AES.GCM.SealedBox(combined: files.read(url, maximumBytes: 4 * 1024 * 1024))
        let data = try AES.GCM.open(box, using: key, authenticating: Data(partition.utf8))
        let decoded = try JSONDecoder().decode([MobileEditRecoveryRecord].self, from: data)
        records = decoded
        return decoded
    }

    func save(_ record: MobileEditRecoveryRecord) throws {
        var current = try load()
        current.removeAll { $0.id == record.id }
        current.append(record)
        try persist(current)
    }

    func remove(_ id: UUID) throws {
        var current = try load()
        current.removeAll { $0.id == id }
        try persist(current)
    }

    func clear() throws {
        if files.exists(url) { try files.removeFile(url) }
        records = []
    }

    private func persist(_ current: [MobileEditRecoveryRecord]) throws {
        if current.isEmpty {
            try clear()
            return
        }
        let key = try vault.key(for: partition, createIfMissing: true)
        let data = try JSONEncoder().encode(current)
        guard data.count <= 4 * 1024 * 1024 else { throw EncryptedCardFormDraftStorageError.oversizedRecord }
        let box = try AES.GCM.seal(data, using: key, authenticating: Data(partition.utf8))
        guard let combined = box.combined else { throw EncryptedCardFormDraftStorageError.invalidCiphertext }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try files.writeAtomically(combined, to: url)
        records = current
    }
}
