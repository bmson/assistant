import CryptoKit
import EventKit
import Foundation
import Observation
import Security

enum PhoneCalendarInstallationIdentity {
    static var current: String {
        let defaults = UserDefaults.standard
        let key = "assistant.phoneCalendarSharing.installationID"
        if let value = defaults.string(forKey: key), !value.isEmpty { return value }
        let value = UUID().uuidString.lowercased()
        defaults.set(value, forKey: key)
        return value
    }
}

struct PhoneCalendarSharingLocalRecord: Codable {
    var publisherId: String
    var generation: Int
    var installationID: String? = PhoneCalendarInstallationIdentity.current
    var uploadsPausedForPermissionReview: Bool? = false
    var pendingMutation: PendingPhoneCalendarMutation?
    var pendingRevocation: PendingPhoneCalendarRevocation?
    var lastRead: PhoneCalendarSharingRead?
    var lastState: PhoneCalendarSharingState?
}

struct PendingPhoneCalendarMutation: Codable {
    let body: PhoneCalendarSharingCommandBody
    let baselineGeneration: Int
}

@MainActor
protocol PhoneCalendarSharingRecordStore {
    func load(scope: String) -> PhoneCalendarSharingLocalRecord?
    func save(_ record: PhoneCalendarSharingLocalRecord, scope: String) -> Bool
}

@MainActor
private final class KeychainPhoneCalendarSharingRecordStore: PhoneCalendarSharingRecordStore {
    func load(scope: String) -> PhoneCalendarSharingLocalRecord? {
        guard let data = LocalRecordKeychain.read(account: scope) else { return nil }
        return try? JSONDecoder().decode(PhoneCalendarSharingLocalRecord.self, from: data)
    }

    func save(_ record: PhoneCalendarSharingLocalRecord, scope: String) -> Bool {
        guard let data = try? JSONEncoder().encode(record) else { return false }
        do { try LocalRecordKeychain.write(data, account: scope); return true }
        catch { return false }
    }
}

/// Calendar upload is an independent, explicit consent path. It never reads the
/// display store's event cache and every EventKit event query has an explicit
/// set of calendars selected for sharing.
@MainActor @Observable
final class PhoneCalendarSharingCoordinator {
    private(set) var serverRead: PhoneCalendarSharingRead?
    private(set) var serverState: PhoneCalendarSharingState?
    private(set) var calendars: [PhoneCalendar] = []
    private(set) var access: PhoneCalendarAccess
    private(set) var isWorking = false
    private(set) var errorMessage: String?
    private(set) var statusMessage: String?
    private(set) var isOwnerVerified = false
    private(set) var hasPendingRevocation = false
    @ObservationIgnored private(set) var lastSnapshotPreparationDuration: Duration?

    @ObservationIgnored private let source: any PhoneCalendarSource
    @ObservationIgnored private let recordStore: any PhoneCalendarSharingRecordStore
    @ObservationIgnored private let deviceTimeZone: TimeZone
    @ObservationIgnored private let installationID: String
    @ObservationIgnored private var requestRevision = 0
    @ObservationIgnored private var activeWorkCount = 0
    @ObservationIgnored private var completedSnapshotPublicationRevision = 0
    @ObservationIgnored private var activeRefreshID: UUID?
    @ObservationIgnored private var activeRefreshTask: Task<PhoneCalendarSharingRead, Error>?
    @ObservationIgnored private var activeScope: String?
    @ObservationIgnored private var activeOwnerID: String?
    @ObservationIgnored private var activeBaseURL: String?
    @ObservationIgnored private var localRecord: PhoneCalendarSharingLocalRecord?

    init(
        source: (any PhoneCalendarSource)? = nil,
        recordStore: (any PhoneCalendarSharingRecordStore)? = nil,
        deviceTimeZone: TimeZone = .autoupdatingCurrent,
        installationID: String = PhoneCalendarInstallationIdentity.current
    ) {
        self.source = source ?? EventKitCalendarSource()
        self.recordStore = recordStore ?? KeychainPhoneCalendarSharingRecordStore()
        self.deviceTimeZone = deviceTimeZone
        self.installationID = installationID
        access = self.source.access
    }

    var isSharingEnabled: Bool {
        serverState?.enabled == true && !requiresReplace
            && !requiresPermissionReview
            && localRecord?.pendingRevocation == nil
    }
    var localPublisherID: String? { localRecord?.publisherId }
    var hasPendingMutation: Bool { localRecord?.pendingMutation != nil }
    var hasPendingRemoval: Bool { localRecord?.pendingRevocation != nil }
    var requiresReplace: Bool {
        guard let publisher = serverState?.publisherId else { return false }
        return publisher != localRecord?.publisherId || localRecord?.installationID != installationID
    }
    var requiresPermissionReview: Bool {
        localRecord?.uploadsPausedForPermissionReview == true
            || activeScope.map(Self.permissionPauseIsStored) == true
    }
    var ownerEmail: String? { serverRead?.ownerEmail }
    var ownerTimeZone: String? { serverRead?.timeZone }

    func matchesBinding(client: APIClient, expectedOwnerID: String) -> Bool {
        activeOwnerID == expectedOwnerID
            && activeBaseURL == Self.normalizedBaseURL(client.configuration.baseURL)
    }

    func requestCalendarAccess() async {
        guard !isWorking else { return }
        beginWork()
        defer { endWork() }
        do {
            if source.access != .fullAccess { _ = try await source.requestAccess() }
            access = source.access
            calendars = access == .fullAccess ? source.calendars().sorted {
                ($0.account, $0.title, $0.id) < ($1.account, $1.title, $1.id)
            } : []
            errorMessage = nil
        } catch {
            access = source.access
            errorMessage = "Couldn’t request calendar access. Check iPhone Settings and try again."
        }
    }

    /// Establishes the server and verified owner binding before any queued
    /// mutation is replayed. A pending revoke is never sent using another
    /// server's or another owner's current credential.
    func refresh(client: APIClient, expectedOwnerID: String, publishIfEnabled: Bool) async {
        guard activeRefreshTask == nil else { return }
        let requestedBaseURL = Self.normalizedBaseURL(client.configuration.baseURL)
        let requestedScope = Self.scopeKey(baseURL: requestedBaseURL, ownerID: expectedOwnerID)
        var permissionPauseSaveFailed = false
        // Record an observed OS permission loss before networking. If the GET is
        // offline, this local pause still prevents a later permission grant from
        // silently resuming the old opt-in.
        if source.access != .fullAccess, var cached = recordStore.load(scope: requestedScope),
           cached.lastState?.enabled == true || cached.pendingMutation != nil {
            cached.uploadsPausedForPermissionReview = true
            Self.storePermissionPause(true, scope: requestedScope)
            let saved = recordStore.save(cached, scope: requestedScope)
            if activeScope == requestedScope { localRecord = cached }
            statusMessage = "Calendar access changed. Uploads are paused until you review and confirm sharing again."
            permissionPauseSaveFailed = !saved
        }
        requestRevision += 1
        let revision = requestRevision
        let refreshID = UUID()
        let refreshTask = Task { try await client.phoneCalendarSharing() }
        activeRefreshID = refreshID
        activeRefreshTask = refreshTask
        beginWork()
        defer {
            if activeRefreshID == refreshID {
                activeRefreshID = nil
                activeRefreshTask = nil
            }
            endWork()
        }
        errorMessage = permissionPauseSaveFailed
            ? "Calendar uploads are paused locally, but the pause could not be saved securely. Reopen sharing settings before uploading."
            : nil
        do {
            let read = try await refreshTask.value
            guard revision == requestRevision else { return }
            guard read.ownerId == expectedOwnerID,
                  read.state == nil || read.state?.ownerId == read.ownerId,
                  !read.ownerEmail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  TimeZone(identifier: read.timeZone) != nil else {
                clearVerifiedBinding()
                errorMessage = "Calendar sharing could not verify this server account."
                return
            }
            let baseURL = Self.normalizedBaseURL(client.configuration.baseURL)
            let scope = Self.scopeKey(baseURL: baseURL, ownerID: read.ownerId)
            activeScope = scope
            activeBaseURL = baseURL
            activeOwnerID = read.ownerId
            serverRead = read
            serverState = read.state
            isOwnerVerified = true
            access = source.access
            calendars = access == .fullAccess ? source.calendars().sorted {
                ($0.account, $0.title, $0.id) < ($1.account, $1.title, $1.id)
            } : []
            localRecord = recordStore.load(scope: scope)
            if var record = localRecord {
                if Self.permissionPauseIsStored(scope: scope) { record.uploadsPausedForPermissionReview = true }
                if access != .fullAccess, read.state?.enabled == true,
                   read.state?.publisherId == record.publisherId {
                    record.uploadsPausedForPermissionReview = true
                    Self.storePermissionPause(true, scope: scope)
                    statusMessage = "Calendar access changed. Uploads are paused until you review and confirm sharing again."
                }
                record.lastRead = read
                record.lastState = read.state
                record.generation = max(record.generation, read.state?.generation ?? 0)
                _ = recordStore.save(record, scope: scope)
                localRecord = record
            }
            hasPendingRevocation = localRecord?.pendingRevocation != nil
            if await settlePendingRevocation(client: client, revision: revision) { return }
            await settlePendingMutation(client: client, revision: revision)
            guard revision == requestRevision else { return }
            if publishIfEnabled, localRecord?.pendingMutation == nil,
               localRecord?.pendingRevocation == nil, serverState?.enabled == true {
                await publishSnapshot(client: client, revision: revision)
            }
        } catch {
            guard revision == requestRevision else { return }
            let baseURL = Self.normalizedBaseURL(client.configuration.baseURL)
            let scope = Self.scopeKey(baseURL: baseURL, ownerID: expectedOwnerID)
            if let cached = recordStore.load(scope: scope), cached.lastRead?.ownerId == expectedOwnerID {
                activeScope = scope
                activeBaseURL = baseURL
                activeOwnerID = expectedOwnerID
                localRecord = cached
                serverRead = cached.lastRead
                serverState = cached.lastState
                isOwnerVerified = false
                hasPendingRevocation = cached.pendingRevocation != nil
            } else {
                clearVerifiedBinding()
            }
            errorMessage = "Couldn’t check calendar sharing with your assistant server."
        }
    }

    /// The user has selected each calendar and its purpose in the review UI.
    /// Persist the publisher, baseline, and mutation UUID before the POST so a
    /// retry after a lost response is idempotent and a later revoke can cancel it.
    func enable(
        client: APIClient,
        expectedOwnerID: String,
        command: String = "enable",
        selectedCalendars: [SharedPhoneCalendar]
    ) async {
        guard !isWorking, isOwnerVerified, activeOwnerID == expectedOwnerID,
              let scope = activeScope, serverRead != nil,
              activeBaseURL == Self.normalizedBaseURL(client.configuration.baseURL),
              localRecord?.pendingRevocation == nil,
              !selectedCalendars.isEmpty, selectedCalendars.count <= 100,
              Set(selectedCalendars.map(\.id)).count == selectedCalendars.count else {
            errorMessage = "Choose at least one calendar and verify the assistant server before sharing."
            return
        }
        let reviewedCalendars = selectedCalendars.map { calendar -> SharedPhoneCalendar in
            var value = calendar
            value.name = Self.truncateUTF16(value.name, limit: 300)
            return value
        }
        let availableIDs = Set(calendars.map(\.id))
        let previouslySelectedMissingIDs: Set<String> = {
            guard serverState?.publisherId == localRecord?.publisherId else { return [] }
            let previousIDs = Set(serverState?.calendars.map(\.id) ?? [])
            return previousIDs.subtracting(availableIDs)
        }()
        guard reviewedCalendars.allSatisfy({ availableIDs.contains($0.id) || previouslySelectedMissingIDs.contains($0.id) }) else {
            errorMessage = "A selected calendar is no longer available. Review the current calendar list."
            return
        }
        beginWork()
        defer { endWork() }
        let remote = serverState
        var record = localRecord ?? PhoneCalendarSharingLocalRecord(
            publisherId: UUID().uuidString.lowercased(), generation: remote?.generation ?? 0,
            pendingMutation: nil, pendingRevocation: nil, lastRead: serverRead, lastState: remote
        )
        if let remote, let remotePublisher = remote.publisherId,
           remotePublisher != record.publisherId, command != "replace" {
            errorMessage = "Calendar sharing is already published from another iPhone. Review it there or choose Replace after reviewing this iPhone’s calendars."
            return
        }
        if command == "replace" { record.publisherId = UUID().uuidString.lowercased() }
        record.installationID = installationID
        record.uploadsPausedForPermissionReview = false
        record.generation = remote?.generation ?? record.generation
        let mutationID = UUID().uuidString.lowercased()
        let effectiveCommand = command == "enable" && remote?.enabled == true ? "select" : command
        let body = PhoneCalendarSharingCommandBody.configure(
            effectiveCommand, ownerId: expectedOwnerID, publisherId: record.publisherId, expectedGeneration: record.generation,
            mutationId: mutationID, calendars: reviewedCalendars
        )
        record.pendingMutation = PendingPhoneCalendarMutation(body: body, baselineGeneration: record.generation)
        record.pendingRevocation = nil
        guard recordStore.save(record, scope: scope) else {
            errorMessage = "This iPhone couldn’t save the pending sharing change securely. No server change was sent."
            return
        }
        Self.storePermissionPause(false, scope: scope)
        localRecord = record
        await sendPendingMutation(client: client, scope: scope)
        if serverState?.enabled == true {
            requestRevision += 1
            await publishSnapshot(client: client, revision: requestRevision)
        }
    }

    /// A local tombstone is durable before the network call. If the device is
    /// offline, the UI reports that sharing is queued for removal and retains
    /// only enough identity to retry after the exact owner signs in again.
    func disable(client: APIClient, expectedOwnerID: String) async {
        guard activeOwnerID == expectedOwnerID,
              let scope = activeScope, let baseURL = activeBaseURL,
              baseURL == Self.normalizedBaseURL(client.configuration.baseURL),
              let ownerID = activeOwnerID,
              let read = serverRead ?? localRecord?.lastRead,
              isOwnerVerified || read.ownerId == expectedOwnerID else {
            errorMessage = "Connect to the same verified assistant account to remove calendar sharing."
            return
        }
        if localRecord?.pendingRevocation != nil {
            hasPendingRevocation = true
            await sendRevocation(client: client, scope: scope)
            return
        }
        let state = serverState
        var record = localRecord ?? PhoneCalendarSharingLocalRecord(
            publisherId: state?.publisherId ?? UUID().uuidString.lowercased(),
            generation: state?.generation ?? 0, pendingMutation: nil, pendingRevocation: nil,
            lastRead: serverRead, lastState: state
        )
        let canceledMutationID = record.pendingMutation?.body.mutationId
        let baseGeneration = record.pendingMutation?.baselineGeneration ?? state?.generation ?? record.generation
        let tombstoneGeneration = max(baseGeneration + 1, (state?.generation ?? baseGeneration) + 1)
        let revoke = PendingPhoneCalendarRevocation(
            baseURL: baseURL, ownerId: ownerID, ownerEmail: read.ownerEmail,
            publisherId: record.publisherId, expectedGeneration: baseGeneration,
            tombstoneGeneration: tombstoneGeneration, cancelPendingMutationId: canceledMutationID
        )
        record.pendingRevocation = revoke
        record.pendingMutation = nil
        guard recordStore.save(record, scope: scope) else {
            errorMessage = "This iPhone couldn’t save the removal request securely. No server change was sent."
            return
        }
        requestRevision += 1
        localRecord = record
        hasPendingRevocation = true
        statusMessage = "Calendar sharing is queued for removal."
        await sendRevocation(client: client, scope: scope)
    }

    func synchronizeBeforeChat(
        client: APIClient,
        expectedOwnerID: String,
        timeout: Duration = .seconds(5)
    ) async -> Bool {
        let deadline = ContinuousClock.now + timeout
        let initialRevision = requestRevision
        let baseURL = Self.normalizedBaseURL(client.configuration.baseURL)
        let wasAlreadyWorking = isWorking
        let publicationRevision = completedSnapshotPublicationRevision
        guard matchesBinding(client: client, expectedOwnerID: expectedOwnerID) else { return false }
        // A foreground refresh can already be in its GET -> reconciliation -> PUT
        // pipeline. Wait for that whole operation before considering another GET.
        while isWorking, ContinuousClock.now < deadline {
            guard !Task.isCancelled, requestRevision == initialRevision,
                  matchesBinding(client: client, expectedOwnerID: expectedOwnerID) else { return false }
            try? await Task.sleep(for: .milliseconds(25))
        }
        guard !Task.isCancelled, requestRevision == initialRevision,
              matchesBinding(client: client, expectedOwnerID: expectedOwnerID),
              ContinuousClock.now < deadline else { return false }
        if wasAlreadyWorking, completedSnapshotPublicationRevision != publicationRevision,
           hasCurrentSnapshot, errorMessage == nil { return true }

        let refreshBaseRevision = requestRevision
        let refreshTask = Task { @MainActor [weak self] in
            guard let self, !Task.isCancelled,
                  self.requestRevision == refreshBaseRevision,
                  self.activeOwnerID == expectedOwnerID,
                  self.activeBaseURL == baseURL else { return }
            await self.refresh(client: client, expectedOwnerID: expectedOwnerID, publishIfEnabled: true)
        }
        _ = refreshTask // Keep the bounded waiter independent of the URL request timeout.
        await Task.yield()
        while ContinuousClock.now < deadline {
            guard !Task.isCancelled, matchesBinding(client: client, expectedOwnerID: expectedOwnerID) else { return false }
            if !isWorking { break }
            try? await Task.sleep(for: .milliseconds(25))
        }
        return !isWorking && matchesBinding(client: client, expectedOwnerID: expectedOwnerID)
            && errorMessage == nil && hasCurrentSnapshot
    }

    private var hasCurrentSnapshot: Bool {
        guard isOwnerVerified, !requiresReplace, !requiresPermissionReview,
              !hasPendingMutation, !hasPendingRemoval,
              let serverState, let ownerTimeZone = serverRead?.timeZone else { return false }
        return PhoneCalendarSnapshotFreshness.evaluate(serverState, ownerTimeZone: ownerTimeZone) == .current
    }

    func cancelInFlightBinding() {
        requestRevision += 1
        activeRefreshTask?.cancel()
        activeRefreshTask = nil
        activeRefreshID = nil
        clearVerifiedBinding()
    }

    private func settlePendingRevocation(client: APIClient, revision: Int) async -> Bool {
        guard revision == requestRevision, let scope = activeScope,
              let pending = localRecord?.pendingRevocation else { return false }
        guard pending.baseURL == activeBaseURL, pending.ownerId == activeOwnerID,
              pending.ownerEmail.caseInsensitiveCompare(serverRead?.ownerEmail ?? "") == .orderedSame else {
            return false
        }
        await sendRevocation(client: client, scope: scope)
        return true
    }

    private func settlePendingMutation(client: APIClient, revision: Int) async {
        guard revision == requestRevision, let scope = activeScope,
              localRecord?.pendingMutation != nil, localRecord?.pendingRevocation == nil else { return }
        guard !requiresReplace, !requiresPermissionReview else {
            statusMessage = "A saved sharing change needs review on this iPhone before it can be retried."
            return
        }
        await sendPendingMutation(client: client, scope: scope)
    }

    private func sendPendingMutation(client: APIClient, scope: String) async {
        guard var record = localRecord, let pending = record.pendingMutation else { return }
        guard record.installationID == installationID,
              record.uploadsPausedForPermissionReview != true,
              !Self.permissionPauseIsStored(scope: scope) else {
            statusMessage = "A saved sharing change needs review on this iPhone before it can be retried."
            return
        }
        let ownerID = activeOwnerID
        let baseURL = activeBaseURL
        beginWork()
        defer { endWork() }
        do {
            let result = try await client.configurePhoneCalendarSharing(pending.body)
            guard activeScope == scope, activeOwnerID == ownerID, activeBaseURL == baseURL,
                  serverRead?.ownerId == pending.body.ownerId,
                  localRecord?.pendingMutation?.body.mutationId == pending.body.mutationId,
                  localRecord?.pendingRevocation == nil else { return }
            guard result.state.ownerId == pending.body.ownerId else {
                errorMessage = "Calendar sharing returned a different account identity. No further sharing changes were sent."
                return
            }
            serverState = result.state
            if result.ok || result.state.mutationId == pending.body.mutationId {
                record.generation = result.state.generation
                record.pendingMutation = nil
                record.uploadsPausedForPermissionReview = false
                record.lastState = result.state
                if var cachedRead = record.lastRead { cachedRead.state = result.state; record.lastRead = cachedRead }
                localRecord = record
                _ = recordStore.save(record, scope: scope)
                Self.storePermissionPause(false, scope: scope)
                statusMessage = result.state.enabled ? "Calendar sharing is on." : "Calendar sharing is off."
                errorMessage = nil
            } else {
                record.generation = result.state.generation
                record.pendingMutation = nil
                record.lastState = result.state
                if var cachedRead = record.lastRead { cachedRead.state = result.state; record.lastRead = cachedRead }
                localRecord = record
                _ = recordStore.save(record, scope: scope)
                errorMessage = "Calendar sharing changed on the server. Review the current state before trying again."
            }
        } catch {
            guard activeScope == scope, activeOwnerID == ownerID, activeBaseURL == baseURL,
                  localRecord?.pendingMutation?.body.mutationId == pending.body.mutationId,
                  localRecord?.pendingRevocation == nil else { return }
            errorMessage = "The sharing change hasn’t been confirmed. It will be checked before another update."
        }
    }

    private func sendRevocation(client: APIClient, scope: String) async {
        guard var record = localRecord, let pending = record.pendingRevocation,
              isOwnerVerified,
              pending.baseURL == activeBaseURL, pending.ownerId == activeOwnerID,
              pending.ownerEmail.caseInsensitiveCompare(serverRead?.ownerEmail ?? "") == .orderedSame else { return }
        beginWork()
        defer { endWork() }
        do {
            let result = try await client.revokePhoneCalendarSharing(.init(
                ownerId: pending.ownerId,
                publisherId: pending.publisherId,
                generation: pending.expectedGeneration,
                cancelPendingMutationId: pending.cancelPendingMutationId
            ))
            guard activeScope == scope, activeOwnerID == pending.ownerId,
                  activeBaseURL == pending.baseURL,
                  serverRead?.ownerEmail.caseInsensitiveCompare(pending.ownerEmail) == .some(.orderedSame),
                  localRecord?.pendingRevocation == pending else { return }
            guard result.state.ownerId == pending.ownerId else {
                errorMessage = "Calendar removal returned a different account identity. The queued removal was kept."
                return
            }
            serverState = result.state
            guard result.ok, !result.state.enabled,
                  result.state.generation >= pending.tombstoneGeneration else {
                if Self.isSupersededRevocation(pending, by: result.state) {
                    record.generation = result.state.generation
                    record.pendingRevocation = nil
                    record.pendingMutation = nil
                    record.lastState = result.state
                    if var cachedRead = record.lastRead { cachedRead.state = result.state; record.lastRead = cachedRead }
                    localRecord = record
                    _ = recordStore.save(record, scope: scope)
                    hasPendingRevocation = false
                    statusMessage = result.state.enabled
                        ? "This iPhone’s removal request was superseded. Calendar sharing is still active from another iPhone."
                        : "The server already removed the shared snapshot. Earlier chat messages remain."
                    errorMessage = nil
                    return
                }
                errorMessage = "The server has not confirmed calendar removal yet. The removal request is still saved."
                return
            }
            record.generation = result.state.generation
            record.pendingRevocation = nil
            record.pendingMutation = nil
            record.lastState = result.state
            if var cachedRead = record.lastRead { cachedRead.state = result.state; record.lastRead = cachedRead }
            localRecord = record
            _ = recordStore.save(record, scope: scope)
            hasPendingRevocation = false
            statusMessage = "Calendar sharing is off. The uploaded snapshot was removed. Earlier chat messages remain."
            errorMessage = nil
        } catch {
            guard activeScope == scope, activeOwnerID == pending.ownerId, activeBaseURL == pending.baseURL,
                  localRecord?.pendingRevocation == pending else { return }
            hasPendingRevocation = true
            statusMessage = "Calendar sharing is queued for removal."
            errorMessage = "The server hasn’t confirmed removal. The request will retry when this account reconnects."
        }
    }

    private static func isSupersededRevocation(
        _ pending: PendingPhoneCalendarRevocation,
        by state: PhoneCalendarSharingState
    ) -> Bool {
        guard state.ownerId == pending.ownerId, state.generation > pending.expectedGeneration else { return false }
        if state.enabled {
            return state.publisherId != nil && state.publisherId != pending.publisherId
        }
        return state.publisherId == nil && state.consentVersion == 0
    }

    private func publishSnapshot(client: APIClient, revision: Int) async {
        guard revision == requestRevision, isOwnerVerified,
              localRecord?.pendingRevocation == nil,
              let ownerID = activeOwnerID, let scope = activeScope,
              let state = serverState, state.enabled,
              let publisherID = state.publisherId,
              let ownerEmail = serverRead?.ownerEmail,
              let zoneID = serverRead?.timeZone, let timeZone = TimeZone(identifier: zoneID) else { return }
        guard localRecord?.publisherId == publisherID else {
            errorMessage = "Calendar sharing is active from another iPhone. This device won’t replace or upload over it."
            return
        }
        guard localRecord?.installationID == installationID,
              !requiresPermissionReview else {
            errorMessage = "Review the selected calendars and confirm sharing on this iPhone before uploading again."
            return
        }
        let selected = state.calendars
        guard !selected.isEmpty else { return }
        let now = Date()
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let today = calendar.startOfDay(for: now)
        guard let min = calendar.date(byAdding: .day, value: -7, to: today),
              let max = calendar.date(byAdding: .day, value: 46, to: today) else { return }
        let interval = DateInterval(start: min, end: max)
        let currentCalendars = source.access == .fullAccess ? source.calendars() : []
        let currentByID = Dictionary(currentCalendars.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let selectedIDs = Set(selected.map(\.id))
        var sourceAvailability = selected.map { item -> PhoneCalendarSourceAvailability in
            if source.access != .fullAccess {
                return .init(calendarId: item.id, status: .permissionDenied, complete: false, reason: "Full calendar access is unavailable on this iPhone.")
            }
            guard currentByID[item.id] != nil else {
                return .init(calendarId: item.id, status: .missing, complete: false, reason: "This calendar is no longer available on this iPhone.")
            }
            return .init(calendarId: item.id, status: .available, complete: true, reason: nil)
        }
        let preparationStartedAt = ContinuousClock.now
        let fetchedEvents = source.shareEvents(
            in: interval, calendarIDs: selectedIDs.intersection(Set(currentByID.keys)), verifiedOwnerEmail: ownerEmail
        ).sorted { ($0.start, $0.eventId) < ($1.start, $1.eventId) }
        var unknownZoneIDs = Set<String>()
        var omittedBoundaryIDs = Set<String>()
        let sourceEvents = fetchedEvents.filter { event in
            guard event.calendarTimeZone == nil else { return true }
            unknownZoneIDs.insert(event.calendarId)
            guard event.allDay else { return true }
            guard !Self.allDayEventIsOutsideOwnerWindow(
                event, sourceZone: deviceTimeZone, ownerCalendar: calendar, min: min, max: max
            ) else {
                omittedBoundaryIDs.insert(event.calendarId)
                return false
            }
            return true
        }
        sourceAvailability = sourceAvailability.map { availability in
            guard unknownZoneIDs.contains(availability.calendarId), availability.status == .available else { return availability }
            let reason = omittedBoundaryIDs.contains(availability.calendarId)
                ? "EventKit did not provide a source time zone for some events; an all-day event at the owner-zone window boundary was omitted."
                : "EventKit did not provide a source time zone for some events, so calendar-day membership is uncertain."
            return PhoneCalendarSourceAvailability(
                calendarId: availability.calendarId, status: availability.status, complete: false, reason: reason
            )
        }
        let eventLimit = 2_000
        let initiallyIncludedCount = Swift.min(sourceEvents.count, eventLimit)
        var includedCount = initiallyIncludedCount
        var truncated = sourceEvents.count > initiallyIncludedCount || !omittedBoundaryIDs.isEmpty
        func makeEvents(_ count: Int) -> [PhoneCalendarSharedEvent] {
            sourceEvents.prefix(count).map { event in
                // EventKit's floating and all-day values can have no source zone.
                // Preserve their device-local civil date while leaving the wire
                // zone nil; the owner zone must not be used to claim membership.
                let sourceZone = event.calendarTimeZone.flatMap(TimeZone.init(identifier:)) ?? deviceTimeZone
                return PhoneCalendarSharedEvent(
                    eventId: event.eventId, calendarId: event.calendarId,
                    providerExternalIdentifier: event.providerExternalIdentifier,
                    status: event.status, calendarTimeZone: event.calendarTimeZone,
                    ownerParticipant: event.ownerParticipant,
                    iCalUID: nil, // EventKit does not expose a guaranteed RFC 5545 UID.
                    originalStartTime: event.originalStartTime.map { Self.eventTime($0, allDay: event.allDay, zone: sourceZone) },
                    summary: Self.truncateUTF16(event.summary, limit: 500),
                    location: Self.truncateUTF16(event.location, limit: 2_000),
                    start: Self.eventTime(event.start, allDay: event.allDay, zone: sourceZone),
                    end: Self.eventTime(event.end, allDay: event.allDay, zone: sourceZone),
                    allDay: event.allDay, blocksTime: event.blocksTime
                )
            }
        }
        let wireCalendars = selected.map { calendar -> SharedPhoneCalendar in
                var value = calendar
                value.name = Self.truncateUTF16(value.name, limit: 300)
                value.timeZone = calendar.timeZone
                return value
        }
        let requestBudget = 700_000
        var snapshot: PhoneCalendarSnapshotInput?
        var encodedSize = 0
        // Measure the full HTTP body, including owner, publisher, and roster fields.
        // Ratio-based reductions keep this bounded even for a pathological calendar.
        for _ in 0..<8 {
            if truncated {
                let omittedIDs = Set(sourceEvents.dropFirst(includedCount).map(\.calendarId))
                sourceAvailability = sourceAvailability.map { availability in
                    guard omittedIDs.contains(availability.calendarId), availability.status == .available else { return availability }
                    return PhoneCalendarSourceAvailability(
                        calendarId: availability.calendarId, status: availability.status,
                        complete: false, reason: "Some events were omitted to respect the shared snapshot event or upload size limit."
                    )
                }
            }
            let complete = sourceAvailability.allSatisfy { $0.status == .available && $0.complete } && !truncated
            let candidate = PhoneCalendarSnapshotInput(
                timeMin: Self.instant(min), timeMax: Self.instant(max), capturedAt: Self.instant(now),
                selectionRevision: state.generation, complete: complete, truncated: truncated,
                sourceAvailability: sourceAvailability, timeZone: zoneID,
                calendars: wireCalendars, events: makeEvents(includedCount)
            )
            guard let data = try? JSONEncoder().encode(
                PhoneCalendarSnapshotUploadBody(ownerId: ownerID, publisherId: publisherID, generation: state.generation, snapshot: candidate)
            ) else { return }
            encodedSize = data.count
            if encodedSize <= requestBudget {
                snapshot = candidate
                break
            }
            let rosterOnly = PhoneCalendarSnapshotInput(
                timeMin: candidate.timeMin, timeMax: candidate.timeMax, capturedAt: candidate.capturedAt,
                selectionRevision: candidate.selectionRevision, complete: false, truncated: true,
                sourceAvailability: candidate.sourceAvailability, timeZone: candidate.timeZone,
                calendars: candidate.calendars, events: []
            )
            guard let emptyData = try? JSONEncoder().encode(
                PhoneCalendarSnapshotUploadBody(ownerId: ownerID, publisherId: publisherID, generation: state.generation, snapshot: rosterOnly)
            ), emptyData.count < requestBudget, includedCount > 0 else {
                errorMessage = "The selected calendar list is too large to sync safely. Reduce the selection and try again."
                return
            }
            let eventBytes = Swift.max(1, encodedSize - emptyData.count)
            let availableEventBytes = requestBudget - emptyData.count
            let estimatedCount = Double(includedCount) * Double(availableEventBytes) / Double(eventBytes) * 0.9
            let target = Swift.max(0, Int(estimatedCount))
            includedCount = Swift.min(includedCount - 1, target)
            truncated = true
        }
        guard let snapshot else {
            errorMessage = "The shared calendar snapshot could not be reduced to the safe upload size."
            return
        }
        lastSnapshotPreparationDuration = preparationStartedAt.duration(to: ContinuousClock.now)
        let complete = snapshot.complete
        beginWork()
        defer { endWork() }
        do {
            let result = try await client.publishPhoneCalendarSnapshot(
                ownerId: ownerID, publisherId: publisherID, generation: state.generation, snapshot: snapshot
            )
            guard revision == requestRevision, activeScope == scope, activeOwnerID == ownerID else { return }
            guard result.state.ownerId == ownerID else {
                errorMessage = "Calendar sync returned a different account identity. The previous snapshot remains on the server."
                return
            }
            serverState = result.state
            if result.ok {
                if var record = localRecord {
                    record.lastState = result.state
                    record.installationID = installationID
                    if var cachedRead = record.lastRead { cachedRead.state = result.state; record.lastRead = cachedRead }
                    localRecord = record
                    _ = recordStore.save(record, scope: scope)
                }
                statusMessage = complete
                    ? "Calendar sharing is up to date."
                    : snapshot.sourceAvailability.first(where: { !$0.complete })?.reason
                        ?? "Calendar sharing is incomplete; check access and sync on this iPhone."
                errorMessage = nil
                completedSnapshotPublicationRevision += 1
            } else {
                errorMessage = "Calendar sharing changed on the server. Review the sharing settings before syncing again."
            }
        } catch {
            guard revision == requestRevision else { return }
            errorMessage = "Couldn’t update the shared calendar snapshot. The previous snapshot remains on the server until it expires."
        }
    }

    private func clearVerifiedBinding() {
        isOwnerVerified = false
        serverRead = nil
        serverState = nil
        activeScope = nil
        activeOwnerID = nil
        activeBaseURL = nil
        localRecord = nil
        calendars = []
        hasPendingRevocation = false
    }

    private func beginWork() {
        activeWorkCount += 1
        isWorking = activeWorkCount > 0
    }

    private func endWork() {
        activeWorkCount = max(0, activeWorkCount - 1)
        isWorking = activeWorkCount > 0
    }

    private static func normalizedBaseURL(_ url: URL) -> String {
        url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    private static func scopeKey(baseURL: String, ownerID: String) -> String {
        let digest = SHA256.hash(data: Data("\(baseURL)|\(ownerID)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func permissionPauseKey(scope: String) -> String {
        "assistant.phoneCalendarSharing.permissionPause.\(scope)"
    }

    private static func permissionPauseIsStored(scope: String) -> Bool {
        UserDefaults.standard.bool(forKey: permissionPauseKey(scope: scope))
    }

    private static func storePermissionPause(_ paused: Bool, scope: String) {
        let key = permissionPauseKey(scope: scope)
        if paused { UserDefaults.standard.set(true, forKey: key) }
        else { UserDefaults.standard.removeObject(forKey: key) }
    }

    private static func instant(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func truncateUTF16(_ value: String, limit: Int) -> String {
        var result = String.UnicodeScalarView()
        var used = 0
        for scalar in value.unicodeScalars {
            let units = scalar.value > 0xFFFF ? 2 : 1
            guard used + units <= limit else { break }
            result.append(scalar)
            used += units
        }
        return String(result)
    }

    private static func allDayEventIsOutsideOwnerWindow(
        _ event: PhoneCalendarShareEvent,
        sourceZone: TimeZone,
        ownerCalendar: Calendar,
        min: Date,
        max: Date
    ) -> Bool {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = ownerCalendar.timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        guard let start = formatter.date(from: eventTime(event.start, allDay: true, zone: sourceZone)),
              let end = formatter.date(from: eventTime(event.end, allDay: true, zone: sourceZone)) else { return true }
        return end <= min || start >= max
    }

    private static func eventTime(_ date: Date, allDay: Bool, zone: TimeZone) -> String {
        if allDay {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.timeZone = zone
            formatter.dateFormat = "yyyy-MM-dd"
            return formatter.string(from: date)
        }
        return instant(date)
    }
}

private enum LocalRecordKeychain {
    private static let service = "com.baldvinsmarason.assistant.phone-calendar-sharing"

    static func read(account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess ? result as? Data : nil
    }

    static func write(_ data: Data, account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let addStatus = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(addStatus)) }
        } else if status != errSecSuccess {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }
}
