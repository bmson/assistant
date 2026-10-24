import Foundation
import EventKit
import Observation
import SwiftUI
import UIKit
import CoreLocation

#if DEBUG
/// Opt-in metadata for a scoped draft save. Draft text and owner identifiers
/// never enter this receipt; unknown callers have no raw-location fallback.
struct ComposerDraftSaveObservation {
    let sourceFile: String
    let sourceFunction: String
    let sourceLine: Int
    let accepted: Bool
    let scopeMatchesCurrent: Bool
    let sessionMatchesCurrent: Bool
    let requestedLength: Int
    let requestedEmpty: Bool
    let beforeLength: Int
    let beforeEmpty: Bool
    let afterLength: Int
    let afterEmpty: Bool
    let beforeRecovery: Bool
    let afterRecovery: Bool

    static func safeSource(file: String, function: String, line: Int) -> (String, String, Int) {
        let filename = file.split(separator: "/").last.map(String.init) ?? ""
        let allowed: [String: Set<String>] = [
            "ChatView.swift": ["body", "sendDraft()", "synchronizeComposer()", "restoreUnsentMessageIfPossible()"],
            "AppModel.swift": [
                "send(_:autonomous:force:spoken:calendarContextReady:composerDraftContext:onComposerDraftStage:onComposerDraftClear:)",
                "restoreComposerRecoveryByOwner(in:replacing:)",
                "saveComposerDraftChange(_:currentDraft:in:)"
            ],
            "NativeVisualReviewTests.swift": ["testFullHeightChatWithRecoveryAndJump()"],
        ]
        guard allowed[filename]?.contains(function) == true, line > 0 else {
            return ("unknown", "unknown", 0)
        }
        return (filename, function, line)
    }
}
#endif

enum AssistantRoute: String, Hashable, Identifiable, CaseIterable, Sendable {
    case chat
    case chats
    case activity
    case goals
    case approvals
    case cards
    case memory
    case people
    case documents
    case skills
    case capabilities
    case settings
    case costs
    case anomalies
    case improvements

    var id: Self { self }
}

/// All pushed screens share one ordered path. Mixing an item-based submenu
/// with value-based person links inserts the person beneath the submenu.
enum AssistantDestination: Hashable {
    case route(AssistantRoute)
    case person(id: String)
}

/// An action the error banner can offer when a failure is worth another go.
/// Sendable so it can be handed to the `Task` the banner's button starts;
/// capturing `AppModel` is safe because global-actor isolation makes it so.
typealias RetryAction = @MainActor @Sendable () async -> Void
typealias LocalNotificationScheduler = @MainActor (
    String, String, AssistantRoute?, String?, String?, String?
) async -> Bool

/// View-scoped loads are routinely cancelled when a navigation destination is
/// replaced. Cancellation is control flow, not a failed request, so it must
/// never become the global error banner/toast.
func isRequestCancellation(_ error: Error) -> Bool {
    if error is CancellationError { return true }
    if case let APIError.transport(urlError) = error { return isRequestCancellation(urlError) }
    var current = error as NSError
    // Foundation may wrap a cancelled URL request or a dismissed file picker.
    for _ in 0..<4 {
        if current.domain == NSURLErrorDomain, current.code == NSURLErrorCancelled { return true }
        if current.domain == NSCocoaErrorDomain, current.code == NSUserCancelledError { return true }
        guard let underlying = current.userInfo[NSUnderlyingErrorKey] as? NSError else { break }
        current = underlying
    }
    return false
}

enum AssistantErrorSource {
    case bootstrap, overview, workspace
}

struct AssistantErrorNotice: Equatable {
    let title: String
    let message: String
    let systemImage: String

    init(message: String) {
        title = "Couldn’t complete that"
        self.message = message
        systemImage = "exclamationmark.circle"
    }

    init(error: Error) {
        switch error {
        case let APIError.transport(error):
            title = error.code == .notConnectedToInternet ? "You’re offline" : "Connection interrupted"
            message = error.code == .notConnectedToInternet
                ? "Reconnect to the internet, then try again."
                : "Couldn’t reach your assistant. Please try again in a moment."
            systemImage = error.code == .notConnectedToInternet ? "wifi.slash" : "arrow.trianglehead.2.clockwise"
        case APIError.unauthorized:
            title = "Check your connection settings"
            message = error.localizedDescription
            systemImage = "key"
        case APIError.decoding, APIError.invalidResponse:
            title = "Couldn’t load this update"
            message = "The response couldn’t be read. Try refreshing, or check for an app update."
            systemImage = "exclamationmark.circle"
        default:
            title = "Couldn’t complete that"
            message = error.localizedDescription
            systemImage = "exclamationmark.circle"
        }
    }
}

private struct MissingTaskReplyNotice: Equatable {
    let ownerID: String
    let conversationID: String
    let taskID: String
    let connectionVersion: Int
}

/// A message just taken out of the log, and where to put it back. Held only
/// while the undo bar is on screen; hiding is otherwise a quiet action.
struct HiddenMessageUndo: Identifiable, Equatable {
    let messageId: String
    let conversationId: String
    var id: String { messageId }
}

/// A cancelled turn may still be finishing while the next turn settles.
/// Each cleanup owns one token; an older cleanup cannot release a newer one.
struct NotificationTurnSettlements {
    private var tokens: Set<UUID> = []
    var isSettling: Bool { !tokens.isEmpty }

    mutating func begin() -> UUID {
        let token = UUID()
        tokens.insert(token)
        return token
    }

    mutating func finish(_ token: UUID) {
        tokens.remove(token)
    }
}

/// One model observed per property; unrelated projection refreshes do not
/// invalidate a screen that only reads its conversation or draft state.
@MainActor
@Observable
final class AppModel {
    /// Frozen from the packaged app metadata so the token's declared APNs
    /// environment is the same one included in its signed build.
    private let apnsEnvironment = APNSEnvironment(bundle: .main)

    var navigationPath: [AssistantDestination] = [] {
        didSet {
            // Includes page selection, person links, and native back gestures.
            // A slow notice must not replace the owner's newer navigation.
            notificationNavigationVersion += 1
            pendingNotificationDestination = nil
        }
    }
    var presentedRoute: AssistantRoute? {
        get {
            guard case let .route(route) = navigationPath.first else { return nil }
            return route
        }
        set {
            navigationPath = newValue.map { $0 == .chat ? [] : [.route($0)] } ?? []
        }
    }
    private(set) var bootstrap: BootstrapResponse?
    let phoneCalendarSharing: PhoneCalendarSharingCoordinator
    let edits = OptimisticEditStore()
    @ObservationIgnored private var memoryErasureToken: UUID? {
        didSet { edits.retryBlockedResources = memoryErasureToken == nil ? [] : [.memory] }
    }
    private(set) var overview: OverviewResponse? {
        get { edits.visible.overview }
        set { edits.updateRemote(resources: [.overview]) { $0.overview = newValue } }
    }
    private(set) var archivedActivity: ActivityList?
    private(set) var archivedGoals: GoalsDashboard? {
        get { edits.visible.archivedGoals }
        set { edits.updateRemote(resources: [.archivedGoals]) { $0.archivedGoals = newValue } }
    }
    private(set) var workspace: WorkspaceResponse? {
        get { edits.visible.workspace }
        set { edits.updateRemote(resources: [.workspace]) { $0.workspace = newValue } }
    }
    private(set) var workspacePagesLoading: Set<String> = []
    private(set) var workspacePageErrors: [String: String] = [:]
    private(set) var documentPageLoading = false
    private(set) var documentPageError: String?
    private(set) var peoplePagination: CursorPagination?
    private(set) var peoplePageLoading = false
    private(set) var peoplePageError: String?
    private(set) var memoryReviewCount = 0
    private(set) var mcpConnections: [McpConnection] = []
    private(set) var mcpConnectionsLoaded = false
    private(set) var modelProviders: ModelProviderSettings? {
        get { edits.visible.modelProviders }
        set { edits.updateRemote(resources: [.providers]) { $0.modelProviders = newValue } }
    }
    private(set) var savedCards: [SavedCardRecord] {
        get { edits.visible.savedCards }
        set { edits.updateRemote(resources: [.cards]) { $0.savedCards = newValue } }
    }
    private(set) var activeConversation: ConversationView?
    private(set) var personProfiles: [String: PersonProfileResponse] {
        get { edits.visible.personProfiles }
        set { edits.updateRemote(resources: [.person("")]) { $0.personProfiles = newValue } }
    }
    /// The People directory, loaded when that screen opens.
    private(set) var people: [PersonSummary] {
        get { edits.visible.people }
        set { edits.updateRemote(resources: [.people]) { $0.people = newValue } }
    }
    private(set) var peopleLoaded = false
    private(set) var cachedCalls: [PhoneCall]?
    private(set) var cachedSituationPacks: SituationOverview?
    @ObservationIgnored private var graphCache: [RelationshipGraphQuery: RelationshipGraphSnapshot] = [:]
    @ObservationIgnored private var graphCacheRecency: [RelationshipGraphQuery] = []
    @ObservationIgnored private var memoryLibraryRecency: [MemoryLibraryQuery] = []

    struct RelationshipGraphQuery: Hashable {
        let personID: String?
        let entityID: String?
        let query: String
    }

    func cachedRelationshipGraph(personID: String? = nil, entityID: String? = nil, query: String = "") -> RelationshipGraphSnapshot? {
        graphCache[RelationshipGraphQuery(personID: personID, entityID: entityID, query: query)]
    }
    /// Cards keyed by contact id, so reopening a person is instant and a
    /// tapped relationship can push straight through to the other person.
    private(set) var personCards: [String: PersonCard] {
        get { edits.visible.personCards }
        set { edits.updateRemote(resources: [.person("")]) { $0.personCards = newValue } }
    }
    private(set) var messages: [ChatMessage] = []
    private(set) var isLoading = false
    private(set) var isSending = false {
        didSet {
            if !isSending, pendingNotificationDestination != nil {
                Task { [weak self] in await self?.resolvePendingNotificationDestination() }
            }
        }
    }
    private(set) var isCancellingSend = false
    private(set) var isCardFormAdmissionPending = false
    var hasUnresolvedTurn: Bool { ordinaryTurn != nil || resumableTurn != nil }
    var canCancelCurrentSend: Bool {
        (isSending && !isCardFormAdmissionPending && (ordinaryTurn != nil || resumableTurn?.taskId != nil))
            || (ordinaryTurn != nil && !isCardFormAdmissionPending)
    }
    var hasRequestedCancellationForCurrentSend: Bool {
        ordinaryTurn?.cancellationRequested == true
    }
    @ObservationIgnored private var cancelRequestedWithoutTaskID = false
    private(set) var toolActivity: [ToolActivity] = []
    private(set) var activityThought: AssistantThought?
    private(set) var activityDetail: String?
    /// Setting a message always retires the previous retry: an error that
    /// arrives from somewhere else must not inherit the last one's action.
    /// `reportError(_:retry:)` sets the message first, then the retry.
    var errorMessage: String? {
        didSet {
            if errorMessage != Self.completedTaskReplyUnavailableMessage {
                missingTaskReplyNotice = nil
            }
            errorRetry = nil
            errorSource = nil
            errorNotice = errorMessage.map { AssistantErrorNotice(message: $0) }
        }
    }
    @ObservationIgnored private var missingTaskReplyNotice: MissingTaskReplyNotice?
    private(set) var errorNotice: AssistantErrorNotice?
    @ObservationIgnored private var errorSource: AssistantErrorSource?
    /// Offered by the banner when the failure was the network rather than the
    /// server's answer. Re-running a request the server rejected on its merits
    /// would only reproduce the rejection, so those get no retry.
    var errorRetry: RetryAction?
    /// The one hidden message that can still be put back, offered by a bar
    /// above the composer until it expires. Nil the rest of the time — hiding
    /// is otherwise silent, which is the point of it.
    private(set) var hiddenMessageUndo: HiddenMessageUndo?
    @ObservationIgnored private var hiddenMessageUndoExpiry: Task<Void, Never>?
    private static let hiddenMessageUndoSeconds: TimeInterval = 6
    /// Text of a turn that failed to send, handed back to the composer so the
    /// words are never lost to a network or server failure. ChatView consumes it.
    private(set) var restorableDraft: String?
    private(set) var composerRecoveryRevision = 0
    private(set) var calendarDraftRestoreRevision = 0
    private(set) var isPreparingCalendarContext = false
    // Its session and recovery are read through composerDraftScope/helpers.
    // Keep this tracked even though the storage itself is private.
    private var conversationDrafts = ConversationDrafts()
#if DEBUG
    @ObservationIgnored var composerDraftSaveObserver: (@MainActor (ComposerDraftSaveObservation) -> Void)? = nil
#endif
    private(set) var packDiscussionDraft: String?
    var showingConnection = false
    /// One-shot intent shared by every user-facing way to send a message,
    /// including quick replies and document shortcuts.
    var nextMessageAutonomous = false
    private(set) var hasSavedConnection: Bool

    private(set) var serverURL: String
    @ObservationIgnored private var client: APIClient?
    private(set) var cardFormSession: CardFormMobileSession?
    private var cardFormSessionInitializationFailure: Error?
    private(set) var cardFormComposerBinding: CardFormComposerBinding?
    private(set) var cardFormUnknownOperationId: String?
    private(set) var cardFormUnknownOperationIds = Set<String>()
    private(set) var cardFormRecoveryReady = true
    private(set) var cardFormStateRevision = 0
    private(set) var cardFormTaskRevision = 0
    private(set) var cardFormActiveOperationId: String?
    private(set) var cardFormActiveTaskId: String?
    private(set) var cardFormActiveOwnerMessageTexts: [CardFormScope: String] = [:]
    @ObservationIgnored private var cardFormTerminalTaskStatuses: [String: String] = [:]
    @ObservationIgnored private var cardFormObservedTaskStatuses: [String: String] = [:]
    @ObservationIgnored private var cardFormTaskStatusObservers: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var cardFormTaskObserverIDs: [String: UUID] = [:]
    @ObservationIgnored private var cardFormTaskCursors: [String: String] = [:]
    @ObservationIgnored private var cardFormPreparationVersion = 0
    @ObservationIgnored private var connectionVersion = 0
    private(set) var activityConnectionRevision = 0
    @ObservationIgnored private var pairingAttemptVersion = 0
    @ObservationIgnored private var cursor: String?
    /// Sequence for the rendered log. A merge can only add or replace by id —
    /// where a message belongs is decided here, once per id.
    @ObservationIgnored private var logOrder = ChatLogOrder()
    /// An in-flight poll may predate a successful POST. Terminal decisions
    /// cannot be undone by that older snapshot; reset on server/account change.
    @ObservationIgnored private var acceptedApprovalDecisions: [String: String] = [:]
    /// Decisions whose request is still in flight. The card has already left
    /// the local inbox; an overview read that started before the tap must not
    /// bring it back — nor, with it, the Island.
    @ObservationIgnored private var approvalsBeingDecided: Set<String> = []
    /// The re-read that follows a decision. It runs behind the control rather
    /// than in front of it: the server has already said yes.
    @ObservationIgnored private var approvalReconciliation: Task<Void, Never>?
    /// The same guard for suggestion cards, set once an answer is confirmed. An
    /// accept or dismiss is final and stays; a snooze is protected until its
    /// deadline, so an older poll cannot make Later immediately reappear.
    @ObservationIgnored private var suggestionAnswers: [String: SuggestionAnswer] = [:]
    @ObservationIgnored private var suggestionsBeingAnswered: Set<String> = []
    @ObservationIgnored private var pendingNotificationDestination: AssistantNotificationDestination?
    @ObservationIgnored private var notificationNavigationVersion = 0
    @ObservationIgnored private var conversationIntentGeneration = 0
    @ObservationIgnored private var isResolvingNotification = false
    @ObservationIgnored private var notificationTurnSettlements = NotificationTurnSettlements()
    @ObservationIgnored private var cardsBeingRefreshed: Set<String> = []
    @ObservationIgnored private var cardRefreshMarkers: [String: CardRefreshMarker] = [:]
    /// Kept across a lost refresh receipt so retrying the same immutable card
    /// revision reuses its server idempotency key.
    @ObservationIgnored private var cardRefreshOperations: [String: String] = [:]
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var phoneCalendarSyncTask: Task<Void, Never>?
    @ObservationIgnored private var phoneCalendarSyncRevision = 0
    @ObservationIgnored private var phoneCalendarEventDebounceTask: Task<Void, Never>?
    @ObservationIgnored private var phoneCalendarEventDebounceRevision = PhoneCalendarEventRefreshRevision()
    @ObservationIgnored private var phoneCalendarEventStoreObserver: NSObjectProtocol?
    @ObservationIgnored private var calendarPreflightRevision = 0
    @ObservationIgnored private var idleTask: Task<Void, Never>?
    @ObservationIgnored private var idlePollingVersion = 0
    /// The turn in flight, kept so returning to the foreground can pick the
    /// reply back up. Backgrounding cancels `pollTask`; the server carries on.
    @ObservationIgnored private var resumableTurn: (taskId: String?, streamID: String)?
    private struct OrdinaryTurn {
        let token: UUID
        let operationId: String
        let conversationId: String
        let streamID: String
        let userMessageID: String
        let ownerText: String
        let requestBody: Data
        var taskId: String?
        var cancellationRequested: Bool
    }
    @ObservationIgnored private var ordinaryTurn: OrdinaryTurn?
    /// When the app was last backgrounded, for deciding whether the connection
    /// pool has had time to go stale.
    @ObservationIgnored private var backgroundedAt: Date?
    /// How long backgrounded before the pool is assumed dead. Short, because
    /// being wrong costs one TCP handshake and being right saves the owner a
    /// full inactivity timeout staring at a spinner.
    private static let staleConnectionSeconds: TimeInterval = 30
    /// Idle polling is an in-app freshness affordance, never background work.
    /// Scene transitions cancel it so the OS can suspend the app cleanly and
    /// we do not wake the server while the owner cannot see a response.
    @ObservationIgnored private var isSceneActive = true
    @ObservationIgnored private var thoughtClearTask: Task<Void, Never>?
    @ObservationIgnored private var lastNotifiedTaskState: String?
    /// How much of the reply in flight has been read aloud. Only a turn the
    /// owner started speaks: a proactive notice arriving while the phone is on
    /// a table is not something to announce to the room.
    @ObservationIgnored private var spokenTurn: SpokenTurn?
    /// Talk mode reads every reply whether or not the setting is on — with no
    /// transcript on screen, speech is the only thing there to answer with.
    var speechAlwaysOn = false

    private let defaults: UserDefaults
    private let storeConnectionToken: (String) throws -> Void
    private let enqueueAutomaticSpeech: @MainActor (ChatMessage) -> Void
    private let scheduleLocalNotification: LocalNotificationScheduler
    private let serverKey = "assistant.server-url"
    private let configuredKey = "assistant.connection-configured"
    /// More → Assistant context owns this toggle; the model only reads it.
    static let shareLocationKey = "assistant.share-location"
    static let arrivalNudgesKey = "assistant.arrival-nudges"
    private static let cancelledTaskEffectNotice =
        "The task was cancelled. Any external action already started may still have taken effect."
    private static let completedTaskReplyUnavailableMessage =
        "This task is marked complete, but its reply has not appeared yet."
    /// One-time notification ask after a successful pairing (APNs opt-in).
    private let pushPromptedKey = "assistant.push-prompted"
    @ObservationIgnored private var lastLocationPostAt: Date?
    @ObservationIgnored private var lastForegroundReportAt: Date?
    @ObservationIgnored private var locationConsentGeneration = 0
    private let captureCurrentPlace: @MainActor () async -> (location: CLLocation, label: String)?

    init(
        apiClient: APIClient? = nil,
        initialMessages: [ChatMessage] = [],
        defaults: UserDefaults = .standard,
        storeConnectionToken: @escaping (String) throws -> Void = { try KeychainStore.saveToken($0) },
        enqueueAutomaticSpeech: @escaping @MainActor (ChatMessage) -> Void = { message in
            SpeechPlayer.shared.enqueue(SpeakableText.passages(for: message), for: message.id)
        },
        scheduleLocalNotification: LocalNotificationScheduler? = nil,
        phoneCalendarSharing: PhoneCalendarSharingCoordinator? = nil,
        captureCurrentPlace: @escaping @MainActor () async -> (location: CLLocation, label: String)? = {
            await LocationManager.shared.captureCurrentPlace()
        }
    ) {
        self.defaults = defaults
        self.phoneCalendarSharing = phoneCalendarSharing ?? PhoneCalendarSharingCoordinator()
        self.storeConnectionToken = storeConnectionToken
        self.enqueueAutomaticSpeech = enqueueAutomaticSpeech
        self.scheduleLocalNotification = scheduleLocalNotification ?? { title, body, route, approvalId, agentID, conversationID in
            await NotificationManager.shared.schedule(
                title: title,
                body: body,
                route: route,
                approvalId: approvalId,
                agentID: agentID,
                conversationID: conversationID
            )
        }
        self.captureCurrentPlace = captureCurrentPlace
        messages = initialMessages
        serverURL = defaults.string(forKey: serverKey) ?? "http://localhost:3000"
        hasSavedConnection = defaults.bool(forKey: configuredKey)
        if let apiClient {
            client = apiClient
        } else if let configuration = try? Self.configuration(urlString: serverURL, token: KeychainStore.readToken()) {
            client = APIClient(configuration: configuration)
        }
        // RootView's `.task` starts the automatic connect after the first
        // render. Without seeding this, that render fell through to the
        // Connection form, whose appearance latched `hasPresentedConnection`
        // and barred the launch screen for the whole round-trip — a saved
        // pairing saw the login page before landing on the conversation.
        isLoading = hasSavedConnection && client != nil
        // Approve/Deny straight from a notification. The handler goes through
        // the same client call as the in-app buttons, then refreshes so the
        // badge and the Approvals sheet agree with the server.
        NotificationManager.shared.approvalDecisionHandler = { [weak self] approvalId, decision, ownerID in
            guard let self, self.bootstrap?.identity.id == ownerID,
                  self.overview?.approvals.pending.contains(where: { $0.id == approvalId }) == true else { return false }
            return await self.decideApproval(id: approvalId, decision: decision)
        }
        // APNs token upload for proactive pushes. A rotation re-fires this;
        // a failure is retried on the next launch's registration callback.
        NotificationManager.shared.deviceTokenHandler = { [weak self] token, scope in
            guard let self, self.pushRegistrationScope == scope,
                  let apnsEnvironment = self.apnsEnvironment,
                  let client = self.client else { throw APIError.invalidResponse }
            try await client.postDeviceToken(DeviceTokenBody(token: token, environment: apnsEnvironment))
        }
        phoneCalendarEventStoreObserver = NotificationCenter.default.addObserver(
            forName: .EKEventStoreChanged, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.phoneCalendarEventsChanged() }
        }
    }

    deinit {
        pollTask?.cancel()
        idleTask?.cancel()
        thoughtClearTask?.cancel()
    }

    var agentName: String { bootstrap?.identity.name ?? "Assistant" }
    private var pushRegistrationScope: String? {
        guard let client, let ownerID = bootstrap?.identity.id,
              let apnsEnvironment else { return nil }
        return "\(client.configuration.baseURL.absoluteString)|\(ownerID)|\(apnsEnvironment.rawValue)"
    }
    var presence: AssistantPresence {
        if isSending { return .working }
        return bootstrap?.shell.dashboard.presence ?? .idle
    }
    var pendingApprovalCount: Int {
        overview?.approvals.pending.count ?? bootstrap?.shell.dashboard.pendingApprovals ?? 0
    }
    var needsAttentionCount: Int { bootstrap?.shell.dashboard.needsAttention ?? 0 }
    var conversationId: String? {
        activeConversation?.conversation.id ?? bootstrap?.conversation.conversation.id
    }
    var composerDraftScope: ComposerDraftScope? {
        guard bootstrap != nil, let conversationId else { return nil }
        return conversationDrafts.scope(conversationID: conversationId)
    }

    func composerDraftSnapshot(in scope: ComposerDraftScope) -> ComposerDraftSnapshot? {
        conversationDrafts.snapshot(in: scope)
    }

    func composerDraft(in scope: ComposerDraftScope) -> String {
        conversationDrafts.draft(in: scope)
    }

    @discardableResult
    func saveComposerDraftChange(_ callbackText: String, currentDraft: String,
                                 in scope: ComposerDraftScope) -> ComposerDraftSnapshot? {
        guard callbackText == currentDraft else { return nil }
        return saveComposerDraft(callbackText, in: scope)
    }

#if DEBUG
    @discardableResult
    func saveComposerDraft(_ text: String, in scope: ComposerDraftScope,
                           sourceFile: String = #fileID, sourceLine: Int = #line,
                           sourceFunction: String = #function) -> ComposerDraftSnapshot? {
        guard composerDraftSaveObserver != nil else {
            return conversationDrafts.save(text, in: scope)
        }
        let before = conversationDrafts.snapshot(in: scope)
        let beforeRecovery = conversationDrafts.hasRecovery(in: scope)
        let saved = conversationDrafts.save(text, in: scope)
        observeComposerDraftSave(text, scope: scope, before: before, after: saved,
                                 beforeRecovery: beforeRecovery,
                                 sourceFile: sourceFile, sourceLine: sourceLine,
                                 sourceFunction: sourceFunction)
        return saved
    }

    @discardableResult
    func saveComposerDraft(_ text: String, in scope: ComposerDraftScope,
                           ifUnchangedFrom snapshot: ComposerDraftSnapshot,
                           sourceFile: String = #fileID, sourceLine: Int = #line,
                           sourceFunction: String = #function) -> ComposerDraftSnapshot? {
        guard composerDraftSaveObserver != nil else {
            return conversationDrafts.save(text, in: scope, ifUnchangedFrom: snapshot)
        }
        let before = conversationDrafts.snapshot(in: scope)
        let beforeRecovery = conversationDrafts.hasRecovery(in: scope)
        let saved = conversationDrafts.save(text, in: scope, ifUnchangedFrom: snapshot)
        observeComposerDraftSave(text, scope: scope, before: before, after: saved,
                                 beforeRecovery: beforeRecovery,
                                 sourceFile: sourceFile, sourceLine: sourceLine,
                                 sourceFunction: sourceFunction)
        return saved
    }

    private func observeComposerDraftSave(_ text: String, scope: ComposerDraftScope,
                                          before: ComposerDraftSnapshot?, after: ComposerDraftSnapshot?,
                                          beforeRecovery: Bool,
                                          sourceFile: String, sourceLine: Int, sourceFunction: String) {
        guard let observer = composerDraftSaveObserver else { return }
        let actualAfter = conversationDrafts.snapshot(in: scope)
        let source = ComposerDraftSaveObservation.safeSource(
            file: sourceFile, function: sourceFunction, line: sourceLine)
        observer(ComposerDraftSaveObservation(
            sourceFile: source.0, sourceFunction: source.1, sourceLine: source.2,
            accepted: after != nil, scopeMatchesCurrent: composerDraftScope == scope,
            sessionMatchesCurrent: conversationDrafts.session == scope.session,
            requestedLength: text.count, requestedEmpty: text.isEmpty,
            beforeLength: before?.text.count ?? 0, beforeEmpty: before?.text.isEmpty ?? true,
            afterLength: actualAfter?.text.count ?? 0, afterEmpty: actualAfter?.text.isEmpty ?? true,
            beforeRecovery: beforeRecovery,
            afterRecovery: conversationDrafts.hasRecovery(in: scope)))
    }
#else
    @discardableResult
    func saveComposerDraft(_ text: String, in scope: ComposerDraftScope) -> ComposerDraftSnapshot? {
        conversationDrafts.save(text, in: scope)
    }

    @discardableResult
    func saveComposerDraft(_ text: String, in scope: ComposerDraftScope,
                           ifUnchangedFrom snapshot: ComposerDraftSnapshot) -> ComposerDraftSnapshot? {
        conversationDrafts.save(text, in: scope, ifUnchangedFrom: snapshot)
    }
#endif

    func hasComposerRecovery(in scope: ComposerDraftScope) -> Bool {
        conversationDrafts.hasRecovery(in: scope)
    }

    func restoreComposerRecovery(in scope: ComposerDraftScope, replacing draft: String) -> String? {
        guard let restored = conversationDrafts.restore(in: scope, replacing: draft) else { return nil }
        restorableDraft = nil
        composerRecoveryRevision += 1
        return restored
    }

    /// An explicit owner action may use the current empty snapshot. Automatic
    /// recovery continues to require the editor's previously accepted token.
    func restoreComposerRecoveryByOwner(in scope: ComposerDraftScope,
                                       replacing draft: String) -> ComposerDraftSnapshot? {
        guard composerDraftScope == scope,
              draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let current = conversationDrafts.snapshot(in: scope),
              current.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return restoreComposerRecovery(in: scope, replacing: draft, ifUnchangedFrom: current)
    }

#if DEBUG
    func restoreComposerRecovery(in scope: ComposerDraftScope, replacing draft: String,
                                 ifUnchangedFrom snapshot: ComposerDraftSnapshot,
                                 sourceFile: String = #fileID, sourceLine: Int = #line,
                                 sourceFunction: String = #function) -> ComposerDraftSnapshot? {
        guard composerDraftSaveObserver != nil else {
            guard let restored = conversationDrafts.restore(
                in: scope, replacing: draft, ifUnchangedFrom: snapshot
            ) else { return nil }
            restorableDraft = nil
            composerRecoveryRevision += 1
            return restored
        }
        let before = conversationDrafts.snapshot(in: scope)
        let beforeRecovery = conversationDrafts.hasRecovery(in: scope)
        let restored = conversationDrafts.restore(
            in: scope, replacing: draft, ifUnchangedFrom: snapshot
        )
        if restored != nil {
            restorableDraft = nil
            composerRecoveryRevision += 1
        }
        observeComposerDraftSave(draft, scope: scope, before: before, after: restored,
                                 beforeRecovery: beforeRecovery,
                                 sourceFile: sourceFile, sourceLine: sourceLine,
                                 sourceFunction: sourceFunction)
        return restored
    }
#else
    func restoreComposerRecovery(in scope: ComposerDraftScope, replacing draft: String,
                                 ifUnchangedFrom snapshot: ComposerDraftSnapshot) -> ComposerDraftSnapshot? {
        guard let restored = conversationDrafts.restore(
            in: scope, replacing: draft, ifUnchangedFrom: snapshot
        ) else { return nil }
        restorableDraft = nil
        composerRecoveryRevision += 1
        return restored
    }
#endif

    private func connectionIsCurrent(_ client: APIClient, version: Int) -> Bool {
        !Task.isCancelled && connectionIdentityIsCurrent(client, version: version)
    }

    var activityConnectionVersion: Int { activityConnectionRevision }

    func activityConnectionIsCurrent(version: Int) -> Bool {
        activityConnectionRevision == version && client != nil
    }

    func checklistCorrectionRequestContext() -> ChecklistCorrectionRequestContext? {
        guard let client, let ownerID = bootstrap?.identity.id else { return nil }
        return ChecklistCorrectionRequestContext(
            ownerID: ownerID,
            connectionVersion: activityConnectionRevision,
            client: client
        )
    }

    func checklistCorrectionConnectionIsCurrent(ownerID: String, version: Int) -> Bool {
        activityConnectionRevision == version && client != nil && bootstrap?.identity.id == ownerID
    }

    func securityReviewRequestContext() -> SecurityReviewRequestContext? {
        guard let client, let ownerID = bootstrap?.identity.id else { return nil }
        return SecurityReviewRequestContext(
            ownerID: ownerID,
            connectionVersion: activityConnectionRevision,
            client: client
        )
    }

    func securityReviewConnectionIsCurrent(ownerID: String, version: Int) -> Bool {
        activityConnectionRevision == version && client != nil && bootstrap?.identity.id == ownerID
    }

    /// Cancellation prevents publishing a result, but does not mean the owner
    /// changed assistants. Keep those recovery explanations distinct.
    private func connectionIdentityIsCurrent(_ client: APIClient, version: Int) -> Bool {
        connectionVersion == version && self.client?.configuration == client.configuration
    }
    var latestMood: CompanionMood { CompanionMood.latest(in: messages) }
    /// The expression the runtime sent with the most recent reply. Unused by
    /// the transcript, which has the words; talk mode has nothing else.
    var latestFace: CompanionFace? {
        messages.reversed().compactMap(\.face).first
    }
    var latestQuickReplies: [String] {
        messages.reversed().first(where: { $0.role == .assistant })?.quickReplies ?? []
    }

    func present(_ route: AssistantRoute) {
        if route == .chat {
            returnToChat()
        } else {
            presentedRoute = route
        }
    }

    func returnToChat() {
        presentedRoute = nil
    }

    /// Cold-launch taps wait for authenticated bootstrap. A tap during a turn
    /// waits for that turn to settle instead of interrupting its reply.
    func openNotificationDestination(_ destination: AssistantNotificationDestination) async {
        notificationNavigationVersion += 1
        pendingNotificationDestination = destination
        await resolvePendingNotificationDestination()
    }

    private func resolvePendingNotificationDestination() async {
        guard !isResolvingNotification else { return }
        isResolvingNotification = true
        defer { isResolvingNotification = false }
        while let destination = pendingNotificationDestination,
              let bootstrap, let client, !isSending, !notificationTurnSettlements.isSettling {
            let version = notificationNavigationVersion
            pendingNotificationDestination = nil
            guard destination.belongsTo(ownerID: bootstrap.identity.id) else { continue }
            guard destination.route == .chat else {
                present(destination.route)
                continue
            }
            // Route-only notifications from older servers belong to the main
            // conversation, not whichever side chat happened to be selected.
            let target = destination.conversationID ?? bootstrap.conversation.conversation.id
            do {
                let conversation = try await client.conversation(id: target)
                guard version == notificationNavigationVersion,
                      self.client?.configuration == client.configuration,
                      self.bootstrap?.identity.id == bootstrap.identity.id else { continue }
                guard conversation.conversation.id.lowercased() == target.lowercased() else {
                    throw APIError.invalidResponse
                }
                if isSending || notificationTurnSettlements.isSettling {
                    pendingNotificationDestination = destination
                    continue
                }
                dismissHiddenMessageUndo()
                setActiveConversation(conversation)
                returnToChat()
            } catch {
                guard version == notificationNavigationVersion,
                      self.client?.configuration == client.configuration,
                      self.bootstrap?.identity.id == bootstrap.identity.id else { continue }
                if isSending || notificationTurnSettlements.isSettling {
                    pendingNotificationDestination = destination
                    continue
                }
                // Missing or foreign IDs fail at the owner-scoped endpoint.
                // Retain an authenticated escape rather than a dead-end tap.
                dismissHiddenMessageUndo()
                setActiveConversation(bootstrap.conversation)
                returnToChat()
                errorMessage = "Couldn’t open that conversation. Showing your main conversation."
            }
        }
    }

    /// Quiet on failure: a scoreboard keeps its last scores rather than raising
    /// an error banner every poll while the provider is briefly unreachable.
    func liveScoreboard(leagues: String) async -> LiveScoresPayload? {
        guard let client else { return nil }
        return try? await client.liveScoreboard(leagues: leagues)
    }

    func knowledge(query: String = "", kind: String = "", page: Int = 1) async -> KnowledgeOverview? {
        guard let client else { return nil }
        do { return try await client.knowledge(query: query, kind: kind, page: page) }
        catch { reportError(error); return nil }
    }

    /// Type-ahead search. Returns nil on failure without raising the error
    /// banner: a search box reports its own trouble, and a keystroke that
    /// superseded the last one is not an error at all.
    func searchKnowledge(query: String) async -> [KnowledgeEntity]? {
        guard let client else { return nil }
        do { return try await client.searchKnowledge(query: query) }
        catch { return nil }
    }

    func relationshipGraph(personID: String? = nil, entityID: String? = nil, query: String = "") async -> RelationshipGraphSnapshot? {
        guard let client else { return nil }
        let version = connectionVersion
        let revision = edits.revision(for: [.memory])
        do {
            let snapshot = try await client.relationshipGraph(personID: personID, entityID: entityID, query: query)
            guard connectionIsCurrent(client, version: version), edits.revision(for: [.memory]) == revision else { return nil }
            let key = RelationshipGraphQuery(personID: personID, entityID: entityID, query: query)
            graphCache[key] = snapshot
            graphCacheRecency.removeAll { $0 == key }
            graphCacheRecency.append(key)
            while graphCacheRecency.count > 12 { graphCache.removeValue(forKey: graphCacheRecency.removeFirst()) }
            return snapshot
        }
        catch where isRequestCancellation(error) { return nil }
        catch { reportError(error); return nil }
    }

    func knowledgeItem(id: String) async -> KnowledgeOverview? {
        guard let client else { return nil }
        do { return try await client.knowledgeItem(id: id) }
        catch { reportError(error); return nil }
    }

    func knowledgeRelation(id: String) async -> KnowledgeRelation? {
        guard let client else { return nil }
        do { return try await client.knowledgeRelation(id: id) }
        catch { reportError(error); return nil }
    }

    func removeKnowledgeRelation(id: String) async -> Bool {
        guard let client else { return false }
        do { try await client.removeKnowledgeRelation(id: id); return true }
        catch { reportError(error); return false }
    }

    func refreshPersonEvidence(id: String) async {
        // The same directed claim can appear on both people's cards. Keep the
        // visible card while reloading, but do not reuse other cached dossiers.
        personCards = personCards.filter { $0.key == id }
        await loadPersonCard(id: id)
    }

    func knowledgeReview() async -> KnowledgeReviewInbox? {
        guard let client else { return nil }
        do { return try await client.knowledgeReview() }
        catch { reportError(error); return nil }
    }

    func knowledgeCleanup() async -> KnowledgeCleanupResponse? {
        guard let client else { return nil }
        do { return try await client.knowledgeCleanup() }
        catch { reportError(error); return nil }
    }

    func resolveKnowledgeCleanup(action: String, memoryId: String? = nil) async -> Bool {
        guard let client else { return false }
        do { try await client.resolveKnowledgeCleanup(action: action, memoryId: memoryId); return true }
        catch { reportError(error); return false }
    }

    func knowledgeSourceImpact(id: String) async -> KnowledgeSourceImpact? {
        guard let client else { return nil }
        do { return try await client.knowledgeSourceImpact(id: id) }
        catch { reportError(error); return nil }
    }

    func forgetKnowledgeSource(id: String) async -> Bool {
        guard let client else { return false }
        do { try await client.forgetKnowledgeSource(id: id); return true }
        catch { reportError(error); return false }
    }

    func createKnowledgeConnection(_ mutation: KnowledgeConnectionMutation) async -> Bool {
        await createKnowledgeConnectionID(mutation) != nil
    }

    func createKnowledgeConnectionID(_ mutation: KnowledgeConnectionMutation) async -> String? {
        guard let client else { return nil }
        do { return try await client.createKnowledgeConnection(mutation) }
        catch { reportError(error); return nil }
    }

    func reviewKnowledgeRelation(id: String, approve: Bool) async -> Bool {
        guard let client else { return false }
        do { try await client.reviewKnowledgeRelation(id: id, approve: approve); return true }
        catch { reportError(error); return false }
    }

    func correctKnowledgeRelation(id: String, mutation: KnowledgeConnectionMutation) async -> Bool {
        guard let client else { return false }
        do { try await client.correctKnowledgeRelation(id: id, mutation: mutation); return true }
        catch { reportError(error); return false }
    }

    func updateKnowledgeItem(id: String, action: String, value: String) async -> Bool {
        guard let client else { return false }
        do { try await client.updateKnowledgeItem(id: id, action: action, value: value); return true }
        catch { reportError(error); return false }
    }

    func mergeKnowledgeItem(id: String, targetId: String) async -> Bool {
        guard let client else { return false }
        do { try await client.mergeKnowledgeItem(id: id, targetId: targetId); return true }
        catch { reportError(error); return false }
    }

    func connect() async {
        guard let client else {
            showingConnection = true
            return
        }
        isLoading = true
        errorMessage = nil
        var version = connectionVersion
        let pairingAttempt = pairingAttemptVersion
        let overviewVersion = version
        let hadNativeFormProjection = client.nativeCardFormsEnabled
        client.disableNativeCardForms()
        defer {
            // Cancellation ends the loading state too, but an old connection
            // must not dismiss a newer connection's loading indicator.
            if connectionVersion == version, self.client?.configuration == client.configuration {
                isLoading = false
            }
        }
        do {
            // Bootstrap alone decides whether the pairing is usable: it carries
            // the identity and the conversation the app opens onto, and it is
            // what `bootstrap != nil` gates entry on. Overview is supplementary
            // — approvals, activity, goals — and fetching both in one
            // `try await` meant a single failing dashboard query rejected an
            // otherwise valid connection outright.
            // Start the supplementary read alongside authentication, but keep
            // its original scope. A replacement owner needs a new read.
            async let overviewResult = fetchOverview(client)
            let response = try await client.bootstrap()
            guard connectionIsCurrent(client, version: version), pairingAttempt == pairingAttemptVersion else { return }
            if let existingOwner = bootstrap?.identity.id, existingOwner != response.identity.id {
                connectionVersion += 1
                activityConnectionRevision += 1
                resetConnectedState()
                version = connectionVersion
            }
            try await prepareCardFormSession(for: client, ownerId: response.identity.id, pairingAttempt: pairingAttempt)
            guard connectionIsCurrent(client, version: version), pairingAttempt == pairingAttemptVersion else { return }
            apply(response)
            schedulePhoneCalendarSync(using: client, ownerID: response.identity.id)
            version = connectionVersion
            clearRecoveredError(from: .bootstrap)
            await resolvePendingNotificationDestination()
            guard connectionIsCurrent(client, version: version) else { return }
            await refreshConversationForNewlyEnabledForms(
                using: client, wasEnabled: false, version: version
            )
            guard connectionIsCurrent(client, version: version) else { return }
            let result = version == overviewVersion
                ? await overviewResult : await fetchOverview(client)
            guard connectionIsCurrent(client, version: version) else { return }
            await finishConnectionSetup(using: client, version: version, prefetchedOverview: result)
        } catch {
            guard connectionIsCurrent(client, version: version), pairingAttempt == pairingAttemptVersion else { return }
            if hadNativeFormProjection,
               let session = cardFormSession,
               session.serverIdentity == client.configuration.baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
               session.ownerId == bootstrap?.identity.id {
                client.enableNativeCardForms()
            }
            reportError(error, source: .bootstrap, retry: { [weak self] in
                guard let self else { return }
                await self.connect()
            })
            // A cold server or a dead socket is not a bad pairing. Sending the
            // owner to the connection form for one of those reads as "the app
            // is broken" and invites them to re-enter a key that was fine —
            // so only an answer from the server sends them there.
            if !Task.isCancelled, !isRequestCancellation(error),
               bootstrap == nil, (error as? APIError)?.isTransport != true {
                showingConnection = true
            }
        }
    }

    /// Supplementary reads and device setup follow an authenticated bootstrap.
    /// They cannot reject a usable pairing or publish into a newer session.
    private func finishConnectionSetup(using client: APIClient, version: Int,
                                       prefetchedOverview: ScopedOverviewRead? = nil) async {
        guard connectionIsCurrent(client, version: version) else { return }
        hasSavedConnection = true
        defaults.set(true, forKey: configuredKey)
        NotificationManager.shared.setRegistrationScope(pushRegistrationScope)
        await resolvePendingNotificationDestination()
        guard connectionIsCurrent(client, version: version) else { return }
        if let prefetchedOverview {
            applyOverviewResult(prefetchedOverview, using: client, version: version, reportFailure: true)
            guard connectionIsCurrent(client, version: version) else { return }
            await reconcileBaselineActivity()
            guard connectionIsCurrent(client, version: version) else { return }
            await syncNotificationBadge()
        } else {
            await refreshOverview()
        }
        guard connectionIsCurrent(client, version: version) else { return }
        if isSceneActive { startIdlePolling() }
        await shareLocationIfEnabled(force: true)
        guard connectionIsCurrent(client, version: version) else { return }
        let notifications = NotificationManager.shared
        if notifications.authorizationStatus == .notDetermined,
           !defaults.bool(forKey: pushPromptedKey) {
            defaults.set(true, forKey: pushPromptedKey)
            await notifications.requestAuthorization()
        }
        guard connectionIsCurrent(client, version: version) else { return }
        await notifications.registerForRemoteNotificationsIfAuthorized()
        guard connectionIsCurrent(client, version: version) else { return }
        await reportForegroundActivity()
    }

    /// The "woke up" signal the server's wake-up brief listens for. Throttled
    /// so rapid background/foreground flips stay one cheap POST; the real
    /// dedupe (once per morning) lives server-side.
    func reportForegroundActivity() async {
        guard bootstrap != nil else { return }
        if let last = lastForegroundReportAt, Date().timeIntervalSince(last) < 30 * 60 { return }
        lastForegroundReportAt = Date()
        try? await client?.postForegroundActivity()
    }

    /// Sends the phone's current position (and clock zone) to the owner's own
    /// server for the ambient prompt line. Entirely owner-gated in More →
    /// Assistant context, off by default, and throttled so foregrounding the
    /// app refreshes context without turning the radio into a tracker.
    func shareLocationIfEnabled(force: Bool = false) async {
        guard defaults.bool(forKey: Self.shareLocationKey), let client else { return }
        let consentGeneration = locationConsentGeneration
        let version = connectionVersion
        let arrivalOptIn = defaults.bool(forKey: Self.arrivalNudgesKey)
        if !force,
           let last = lastLocationPostAt,
           Date().timeIntervalSince(last) < (defaults.bool(forKey: Self.arrivalNudgesKey) ? 3 * 60 : 15 * 60) { return }
        guard let place = await captureCurrentPlace() else { return }
        guard connectionIsCurrent(client, version: version),
              defaults.bool(forKey: Self.shareLocationKey),
              defaults.bool(forKey: Self.arrivalNudgesKey) == arrivalOptIn,
              locationConsentGeneration == consentGeneration else { return }
        let ping = LocationPingBody(
            lat: place.location.coordinate.latitude,
            lng: place.location.coordinate.longitude,
            label: place.label,
            accuracyM: place.location.horizontalAccuracy >= 0
                ? Int(place.location.horizontalAccuracy.rounded())
                : nil,
            capturedAt: AssistantFormatters.internetDateTime.string(from: place.location.timestamp),
            timeZone: TimeZone.current.identifier,
            source: "ios-app",
            arrivalOptIn: arrivalOptIn
        )
        do {
            guard defaults.bool(forKey: Self.shareLocationKey),
                  defaults.bool(forKey: Self.arrivalNudgesKey) == arrivalOptIn,
                  locationConsentGeneration == consentGeneration else { return }
            try await client.postLocationPing(ping)
            guard connectionIsCurrent(client, version: version) else { return }
            lastLocationPostAt = Date()
        } catch {
            // Fire-and-forget: the next foreground refresh carries it.
        }
    }

    func locationSharingPreferenceChanged(enabled: Bool) {
        locationConsentGeneration += 1
        if !enabled { lastLocationPostAt = nil }
    }

    func arrivalNudgesPreferenceChanged() {
        locationConsentGeneration += 1
        lastLocationPostAt = nil
    }

    private func prepareCardFormSession(for client: APIClient, ownerId: String, pairingAttempt: Int? = nil) async throws {
        cardFormPreparationVersion &+= 1
        let preparationVersion = cardFormPreparationVersion
        let expectedConnectionVersion = connectionVersion
        func attemptIsCurrent() -> Bool {
            guard !Task.isCancelled,
                  self.cardFormPreparationVersion == preparationVersion,
                  self.connectionVersion == expectedConnectionVersion else { return false }
            if let pairingAttempt { return self.pairingAttemptVersion == pairingAttempt }
            return self.client?.configuration == client.configuration
        }

        let serverIdentity = client.configuration.baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard attemptIsCurrent() else { return }

        if let current = cardFormSession,
           current.serverIdentity == serverIdentity, current.ownerId == ownerId {
            // A reset can clear the in-memory fences while keeping the same
            // encrypted partition. Restore it before advertising form support.
            client.disableNativeCardForms()
            cardFormRecoveryReady = false
            let hadKnownRecoveryFence = hasKnownCardFormRecoveryFence
            do {
                let unsettled = try await current.restoreUnsettled()
                guard attemptIsCurrent(), cardFormSession === current else { return }
                publishCardFormRecovery(unsettled)
                cardFormRecoveryReady = true
                cardFormSessionInitializationFailure = nil
                client.enableNativeCardForms()
            } catch {
                guard attemptIsCurrent(), cardFormSession === current else { return }
                // A known unknown operation cannot be forgotten just because
                // encrypted storage could not be read during reconnect. Keep
                // sends fenced until a later successful restore.
                cardFormRecoveryReady = !hadKnownRecoveryFence
                cardFormSessionInitializationFailure = error
                client.disableNativeCardForms()
            }
            return
        }

        client.disableNativeCardForms()
        cardFormRecoveryReady = false
        if let current = cardFormSession {
            self.client?.disableNativeCardForms()
            do {
                try await current.closeAndRotate()
            } catch {
                guard attemptIsCurrent() else { return }
                cardFormSession = nil
                cardFormComposerBinding = nil
                cardFormRecoveryReady = true
                cardFormSessionInitializationFailure = error
                cardFormActiveOwnerMessageTexts.removeAll()
                client.disableNativeCardForms()
                throw error
            }
            guard attemptIsCurrent() else { return }
            cardFormSession = nil
            cardFormComposerBinding = nil
            cardFormActiveOwnerMessageTexts.removeAll()
            cardFormStateRevision += 1
        }

        do {
            let candidateSession = try CardFormMobileSession(serverIdentity: serverIdentity, ownerId: ownerId)
            let unsettled = try await candidateSession.restoreUnsettled()
            guard attemptIsCurrent() else { return }
            cardFormSession = candidateSession
            publishCardFormRecovery(unsettled)
            cardFormRecoveryReady = true
            cardFormSessionInitializationFailure = nil
            client.enableNativeCardForms()
        } catch let error as CardFormMobileSessionError {
            guard attemptIsCurrent() else { return }
            if case .invalidIdentity = error { throw error }
            cardFormSession = nil
            cardFormRecoveryReady = true
            cardFormSessionInitializationFailure = error
            client.disableNativeCardForms()
        } catch {
            guard attemptIsCurrent() else { return }
            cardFormSession = nil
            cardFormRecoveryReady = true
            cardFormSessionInitializationFailure = error
            client.disableNativeCardForms()
        }
    }

    private func publishCardFormRecovery(_ unsettled: [CardFormDraft]) {
        cardFormActiveOperationId = nil
        cardFormActiveTaskId = nil
        cardFormActiveOwnerMessageTexts.removeAll()
        cardFormObservedTaskStatuses.removeAll()
        cardFormTerminalTaskStatuses.removeAll()
        cardFormUnknownOperationIds = Set(unsettled.compactMap { draft in
            guard case .outcomeUnknown = draft.phase else { return nil }
            return draft.frozenSubmission?.operationId
        })
        // A live request in this process is not unknown yet, but it still
        // fences ordinary Send until its exact response settles.
        for draft in unsettled {
            if case .submitting = draft.phase, let operationId = draft.frozenSubmission?.operationId {
                cardFormUnknownOperationIds.insert(operationId)
            }
            guard case let .activeForm(pointer) = draft.phase else { continue }
            cardFormActiveOperationId = draft.frozenSubmission?.operationId
            cardFormActiveTaskId = pointer.taskId
            if let ownerText = draft.frozenSubmission?.ownerMessageText {
                cardFormActiveOwnerMessageTexts[draft.scope] = ownerText
            }
            cardFormObservedTaskStatuses[pointer.taskId] = pointer.taskStatus
        }
        cardFormUnknownOperationId = cardFormUnknownOperationIds.sorted().first
        cardFormStateRevision += 1
        cardFormTaskRevision += 1
    }

    /// Bootstrap on a new client is intentionally projected without native
    /// forms until the encrypted owner session is ready. Refetch the selected
    /// conversation once at that boundary so a safe prose fallback can become
    /// an interactive form without changing the server's stored message.
    private func refreshConversationForNewlyEnabledForms(
        using client: APIClient, wasEnabled: Bool, version: Int
    ) async {
        guard !wasEnabled, client.nativeCardFormsEnabled,
              connectionIsCurrent(client, version: version),
              let conversationId else { return }
        do {
            let latest = try await client.conversation(id: conversationId)
            guard connectionIsCurrent(client, version: version),
                  self.conversationId == conversationId,
                  latest.conversation.id == conversationId else { return }
            setActiveConversation(latest)
        } catch {
            // Bootstrap prose remains readable if this optional capability
            // refresh fails; the next conversation refresh can recover it.
        }
    }

    func attachCardFormToComposer(scope: CardFormScope, form: CardFormDescriptor) {
        guard scope.conversationId == conversationId,
              scope.ownerId == bootstrap?.identity.id,
              scope.sessionId == cardFormSession?.sessionId else { return }
        cardFormComposerBinding = CardFormComposerBinding(scope: scope, form: form)
        // Explicitly re-attaching a reviewed form is the only transition that
        // makes its previously blocked message eligible for a new operation.
        cardFormActiveOwnerMessageTexts.removeValue(forKey: scope)
    }

    func detachCardFormFromComposer() {
        cardFormComposerBinding = nil
    }

    func sendCardForm(_ rawText: String, onFrozen: @escaping @MainActor () -> Void) {
        guard cardFormRecoveryReady, cardFormUnknownOperationIds.isEmpty,
              cardFormUnknownOperationId == nil else {
            errorMessage = "Check the saved form request before sending another message."
            return
        }
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending, resumableTurn == nil,
              let binding = cardFormComposerBinding,
              let session = cardFormSession,
              let client, binding.scope.conversationId == conversationId,
              binding.scope.ownerId == bootstrap?.identity.id,
              binding.scope.sessionId == session.sessionId else { return }
        isSending = true
        isCardFormAdmissionPending = true
        errorMessage = nil
        let version = connectionVersion
        Task { [weak self] in
            guard let self else { return }
            do {
                let pending = try await session.beginSubmission(binding.scope, form: binding.form, ownerMessageText: text)
                guard self.connectionIsCurrent(client, version: version), self.conversationId == binding.scope.conversationId else {
                    // The request has not left the device yet. Keep the exact
                    // persisted body recoverable instead of leaving a local
                    // `submitting` spinner with no sender.
                    let unknown = CardFormAdmissionResult(
                        operationId: pending.submission.operationId, outcome: .outcomeUnknown
                    )
                    try? await session.record(unknown, scope: binding.scope)
                    if self.connectionIsCurrent(client, version: version),
                       self.conversationId == binding.scope.conversationId,
                       self.cardFormSession === session {
                        self.isCardFormAdmissionPending = false
                        self.cardFormUnknownOperationIds.insert(pending.submission.operationId)
                        self.cardFormUnknownOperationId = pending.submission.operationId
                        self.cardFormStateRevision += 1
                        self.cardFormTaskRevision += 1
                        self.isSending = false
                        self.errorMessage = "The saved form request needs a safe retry before another message can be sent."
                    }
                    return
                }
                self.cardFormTaskRevision += 1
                onFrozen()
                await self.submitCardForm(pending, binding: binding, session: session, client: client, version: version)
            } catch {
                guard self.connectionIsCurrent(client, version: version),
                      self.cardFormSession === session,
                      self.conversationId == binding.scope.conversationId else { return }
                self.isSending = false
                self.isCardFormAdmissionPending = false
                if let draftError = error as? CardFormDraftError {
                    switch draftError {
                    case let .missingRequiredValue(fieldId):
                        self.errorMessage = "Complete the required \(binding.form.fields.first(where: { $0.id == fieldId })?.label ?? "answer") before sending."
                    case let .invalidValue(fieldId) where binding.form.fields.first(where: { $0.id == fieldId })?.type == .date:
                        self.errorMessage = "Enter a valid calendar date before sending."
                    case .invalidValue:
                        self.errorMessage = "Check the form answers and try again."
                    case .requestTooLarge:
                        self.errorMessage = "Some answers make this request too large. Shorten an answer and review it again."
                    default:
                        self.reportError(error)
                    }
                } else {
                    self.reportError(error)
                }
            }
        }
    }

    func retryCardForm(scope: CardFormScope, form: CardFormDescriptor) {
        guard !isSending, resumableTurn == nil,
              let session = cardFormSession, let client,
              scope.ownerId == bootstrap?.identity.id, scope.sessionId == session.sessionId,
              scope.conversationId == conversationId, scope.cardId == form.cardId, scope.formId == form.formId else { return }
        let binding = CardFormComposerBinding(scope: scope, form: form)
        cardFormComposerBinding = binding
        isSending = true
        isCardFormAdmissionPending = true
        errorMessage = nil
        let version = connectionVersion
        Task { [weak self] in
            guard let self else { return }
            do {
                let pending = try await session.retryUnknown(scope)
                guard self.connectionIsCurrent(client, version: version),
                      self.cardFormSession === session,
                      self.conversationId == scope.conversationId else { return }
                self.cardFormTaskRevision += 1
                await self.submitCardForm(pending, binding: binding, session: session, client: client, version: version)
            } catch {
                guard self.connectionIsCurrent(client, version: version),
                      self.cardFormSession === session,
                      self.conversationId == scope.conversationId else { return }
                self.isSending = false
                self.isCardFormAdmissionPending = false
                self.reportError(error)
            }
        }
    }

    private func submitCardForm(
        _ pending: CardFormPendingRequest,
        binding: CardFormComposerBinding,
        session: CardFormMobileSession,
        client: APIClient,
        version: Int
    ) async {
        cardFormUnknownOperationId = pending.submission.operationId
        cardFormUnknownOperationIds.insert(pending.submission.operationId)
        let response = try? await client.submitCardForm(pending)
        // Keep the shared Stop control unavailable until the encrypted local
        // receipt is classified; the POST response alone is not the task receipt.
        // A response can arrive after the owner changes conversations. Settle
        // the encrypted operation for its original scope before deciding which
        // visible conversation is allowed to consume the result.
        guard cardFormSession === session else { return }
        let admission = response?.admission ?? CardFormAdmissionResult(
            operationId: pending.submission.operationId, outcome: .outcomeUnknown
        )
        let recorded: Bool
        do {
            recorded = try await session.record(admission, scope: binding.scope)
        } catch {
            guard cardFormSession === session,
                  connectionIsCurrent(client, version: version),
                  conversationId == binding.scope.conversationId else { return }
            isSending = false
            reportError(error)
            return
        }
        guard cardFormSession === session else { return }
        let isVisibleBinding = connectionIsCurrent(client, version: version)
            && conversationId == binding.scope.conversationId
        if isVisibleBinding { isCardFormAdmissionPending = false }
        guard recorded else {
            // A later response for this operation already settled it. Do not
            // let a late timeout or rejection recreate the unknown fence.
            cardFormUnknownOperationIds.remove(pending.submission.operationId)
            if cardFormUnknownOperationId == pending.submission.operationId {
                cardFormUnknownOperationId = cardFormUnknownOperationIds.sorted().first
            }
            if isVisibleBinding { isSending = false }
            cardFormStateRevision += 1
            return
        }
        cardFormStateRevision += 1
        cardFormTaskRevision += 1
        func preserveUnsentOwnerText() {
            let draftScope = conversationDrafts.scope(conversationID: binding.scope.conversationId)
            conversationDrafts.preserveUnsent(pending.submission.ownerMessageText, in: draftScope)
            if isVisibleBinding {
                restorableDraft = pending.submission.ownerMessageText
                composerRecoveryRevision += 1
            }
        }
        switch admission.outcome {
        case let .accepted(receipt):
            cardFormUnknownOperationIds.remove(pending.submission.operationId)
            if cardFormUnknownOperationId == pending.submission.operationId {
                cardFormUnknownOperationId = cardFormUnknownOperationIds.sorted().first
            }
            if cardFormActiveOperationId == pending.submission.operationId {
                cardFormActiveOperationId = nil
                cardFormActiveTaskId = nil
            }
            cardFormActiveOwnerMessageTexts.removeValue(forKey: binding.scope)
            if cardFormComposerBinding?.scope == binding.scope { cardFormComposerBinding = nil }
            cardFormTerminalTaskStatuses.removeValue(forKey: receipt.taskId)
            rememberCardFormTaskStatus(receipt.taskStatus, taskId: receipt.taskId)
            if isVisibleBinding {
                startCardFormTaskObservation(scope: binding.scope, form: binding.form, receipt: receipt)
            }
            guard isVisibleBinding else {
                if receipt.taskStatus == "done" || receipt.taskStatus == "failed" || receipt.taskStatus == "cancelled" {
                    cardFormTerminalTaskStatuses[receipt.taskId] = receipt.taskStatus
                }
                return
            }
            if let messageCursor = response?.messageCursor { cursor = messageCursor }
            // The server returns the exact durable user-message ID. Add that
            // row immediately so the ordinary log does not wait for a cursor
            // that already advanced past this admission.
            if !messages.contains(where: { $0.id == receipt.messageId }) {
                messages.append(.optimistic(role: .user, text: pending.submission.ownerMessageText, id: receipt.messageId))
                messages = logOrder.ordered(messages)
            }
            resumableTurn = (taskId: receipt.taskId, streamID: "form-\(pending.submission.operationId)")
            setActivityThought(.startingWork, proposedDetail: pending.submission.ownerMessageText)
            pollTask?.cancel()
            let streamID = "form-\(pending.submission.operationId)"
            pollTask = Task { [weak self] in await self?.pollForReply(taskId: receipt.taskId, streamID: streamID) }
        case let .rejected(status, code):
            cardFormUnknownOperationIds.remove(pending.submission.operationId)
            if cardFormUnknownOperationId == pending.submission.operationId {
                cardFormUnknownOperationId = cardFormUnknownOperationIds.sorted().first
            }
            if cardFormComposerBinding?.scope == binding.scope { cardFormComposerBinding = nil }
            preserveUnsentOwnerText()
            guard isVisibleBinding else { return }
            isSending = false
            errorMessage = code == "stale_revision"
                ? "This card changed. Refresh it and review the updated form before sending."
                : "The form was not accepted. Review it and try again."
            errorRetry = nil
            _ = status
        case let .activeForm(pointer):
            cardFormUnknownOperationIds.remove(pending.submission.operationId)
            if cardFormUnknownOperationId == pending.submission.operationId {
                cardFormUnknownOperationId = cardFormUnknownOperationIds.sorted().first
            }
            cardFormActiveOperationId = pending.submission.operationId
            cardFormActiveTaskId = pointer.taskId
            cardFormActiveOwnerMessageTexts[binding.scope] = pending.submission.ownerMessageText
            if cardFormComposerBinding?.scope == binding.scope { cardFormComposerBinding = nil }
            cardFormTerminalTaskStatuses.removeValue(forKey: pointer.taskId)
            rememberCardFormTaskStatus(pointer.taskStatus, taskId: pointer.taskId)
            if isVisibleBinding {
                startCardFormTaskObservation(scope: binding.scope, form: binding.form, taskId: pointer.taskId, fallbackStatus: pointer.taskStatus)
            }
            preserveUnsentOwnerText()
            guard isVisibleBinding else { return }
            isSending = false
            errorMessage = "Another form request is active. You can reply in chat, or review this form again when it finishes."
            errorRetry = nil
        case .outcomeUnknown:
            cardFormUnknownOperationIds.insert(pending.submission.operationId)
            cardFormUnknownOperationId = pending.submission.operationId
            guard isVisibleBinding else { return }
            isSending = false
            errorMessage = "The form result is still unknown. Retry the same submission to check it safely."
            errorRetry = { [weak self] in await self?.retryCardForm(scope: binding.scope, form: binding.form) }
        }
    }

    func cardFormTaskStatus(_ taskId: String) -> String? { cardFormObservedTaskStatuses[taskId] }

    func openCardForm(_ form: CardFormDescriptor) async throws -> (CardFormScope, CardFormDraft) {
        guard let conversationId, let ownerId = bootstrap?.identity.id, let client else {
            throw CardFormMobileSessionError.invalidIdentity
        }
        if cardFormSession == nil {
            try await prepareCardFormSession(for: client, ownerId: ownerId)
        }
        guard let session = cardFormSession, ownerId == session.ownerId else {
            throw cardFormSessionInitializationFailure ?? CardFormMobileSessionError.secureStorageUnavailable
        }
        let result = try await session.open(conversationId: conversationId, form: form)
        if case .outcomeUnknown = result.1.phase, let operationId = result.1.frozenSubmission?.operationId {
            cardFormUnknownOperationIds.insert(operationId)
            cardFormUnknownOperationId = operationId
        }
        if case let .activeForm(pointer) = result.1.phase {
            cardFormActiveOperationId = result.1.frozenSubmission?.operationId
            cardFormActiveTaskId = pointer.taskId
            if let ownerText = result.1.frozenSubmission?.ownerMessageText {
                cardFormActiveOwnerMessageTexts[result.0] = ownerText
            }
            rememberCardFormTaskStatus(pointer.taskStatus, taskId: pointer.taskId)
            startCardFormTaskObservation(scope: result.0, form: form, taskId: pointer.taskId, fallbackStatus: pointer.taskStatus)
        }
        if case let .accepted(receipt) = result.1.phase {
            rememberCardFormTaskStatus(cardFormObservedTaskStatuses[receipt.taskId] ?? receipt.taskStatus, taskId: receipt.taskId)
            startCardFormTaskObservation(scope: result.0, form: form, receipt: receipt)
        }
        return result
    }

    func setCardFormValue(
        scope: CardFormScope, form: CardFormDescriptor, fieldId: String, value: CardFormValue?
    ) async throws -> CardFormDraft {
        guard let session = cardFormSession, scope.ownerId == session.ownerId, scope.sessionId == session.sessionId,
              scope.conversationId == conversationId else { throw CardFormMobileSessionError.invalidIdentity }
        let result = try await session.setValue(value, fieldId: fieldId, conversationId: scope.conversationId, form: form)
        cardFormStateRevision += 1
        return result.1
    }

    func reviewCardForm(scope: CardFormScope, form: CardFormDescriptor, carryCompatibleValues: Bool) async throws -> CardFormDraft {
        guard let session = cardFormSession, scope.ownerId == session.ownerId, scope.sessionId == session.sessionId,
              scope.conversationId == conversationId else { throw CardFormMobileSessionError.invalidIdentity }
        let result = try await session.reviewRevision(conversationId: scope.conversationId, form: form, carryCompatibleValues: carryCompatibleValues)
        cardFormStateRevision += 1
        return result.1
    }

    func resumeRejectedCardForm(scope: CardFormScope) async throws -> CardFormDraft {
        guard let session = cardFormSession, scope.ownerId == session.ownerId, scope.sessionId == session.sessionId else {
            throw CardFormMobileSessionError.invalidIdentity
        }
        let draft = try await session.resumeEditingAfterRejection(scope)
        cardFormStateRevision += 1
        return draft
    }

    func refreshCardFormTask(scope: CardFormScope, receipt: CardFormAdmissionReceipt) async {
        _ = await refreshCardFormTask(scope: scope, taskId: receipt.taskId)
    }

    private func refreshCardFormTask(scope: CardFormScope, taskId: String) async -> Bool {
        guard let client, scope.conversationId == conversationId,
              scope.ownerId == bootstrap?.identity.id, scope.sessionId == cardFormSession?.sessionId else { return false }
        let version = connectionVersion
        do {
            let updates = try await client.updates(
                conversationId: scope.conversationId, taskId: taskId,
                cursor: cardFormTaskCursors[taskId], waitMilliseconds: 0
            )
            guard connectionIsCurrent(client, version: version), self.conversationId == scope.conversationId,
                  self.cardFormSession?.sessionId == scope.sessionId else { return false }
            if let nextCursor = updates.nextCursor { cardFormTaskCursors[taskId] = nextCursor }
            if let status = updates.taskStatus { observeCardFormTask(status, taskId: taskId) }
            return true
        } catch APIError.unauthorized {
            return false
        } catch APIError.server(status: 401, message: _) {
            return false
        } catch APIError.server(status: 403, message: _) {
            return false
        } catch {
            // Keep the durable receipt fenced; a transient read can be retried.
            return true
        }
    }

    private func startCardFormTaskObservation(
        scope: CardFormScope, form: CardFormDescriptor, receipt: CardFormAdmissionReceipt
    ) {
        startCardFormTaskObservation(
            scope: scope, form: form, taskId: receipt.taskId, fallbackStatus: receipt.taskStatus
        )
    }

    func observeActiveCardFormTask(
        scope: CardFormScope, form: CardFormDescriptor, pointer: CardFormActiveTaskPointer
    ) {
        startCardFormTaskObservation(
            scope: scope, form: form, taskId: pointer.taskId, fallbackStatus: pointer.taskStatus
        )
    }

    private func startCardFormTaskObservation(
        scope: CardFormScope, form: CardFormDescriptor, taskId: String, fallbackStatus: String
    ) {
        guard !["done", "failed", "cancelled"].contains(cardFormObservedTaskStatuses[taskId] ?? fallbackStatus),
              let client else { return }
        cardFormTaskStatusObservers.removeValue(forKey: taskId)?.cancel()
        let observerId = UUID()
        cardFormTaskObserverIDs[taskId] = observerId
        let version = connectionVersion
        cardFormTaskStatusObservers[taskId] = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled,
                  self.cardFormTaskObserverIDs[taskId] == observerId,
                  self.connectionIsCurrent(client, version: version),
                  self.conversationId == scope.conversationId,
                  self.cardFormSession?.sessionId == scope.sessionId {
                let shouldContinue = await self.refreshCardFormTask(scope: scope, taskId: taskId)
                if !shouldContinue || ["done", "failed", "cancelled"].contains(self.cardFormObservedTaskStatuses[taskId] ?? fallbackStatus) {
                    break
                }
                try? await Task.sleep(for: .seconds(15))
            }
            if self.cardFormTaskObserverIDs[taskId] == observerId {
                self.cardFormTaskObserverIDs.removeValue(forKey: taskId)
                self.cardFormTaskStatusObservers.removeValue(forKey: taskId)
                self.cardFormTaskCursors.removeValue(forKey: taskId)
            }
        }
    }

    private func rememberCardFormTaskStatus(_ status: String, taskId: String) {
        cardFormObservedTaskStatuses[taskId] = status
        if ["done", "failed", "cancelled"].contains(status) {
            cardFormTerminalTaskStatuses[taskId] = status
        }
    }

    private func observeCardFormTask(_ status: String, taskId: String) {
        guard cardFormObservedTaskStatuses[taskId] != nil else { return }
        rememberCardFormTaskStatus(status, taskId: taskId)
        cardFormTaskRevision += 1
        if ["done", "failed", "cancelled"].contains(status) {
            cardFormTerminalTaskStatuses[taskId] = status
            // Keep the old owner text blocked until the owner explicitly
            // reviews and re-attaches the form; the terminal task only enables that action.
            cardFormTaskObserverIDs.removeValue(forKey: taskId)
            cardFormTaskCursors.removeValue(forKey: taskId)
            cardFormTaskStatusObservers.removeValue(forKey: taskId)?.cancel()
        }
        cardFormStateRevision += 1
    }

    func startNextCardFormEntry(scope: CardFormScope, taskId: String) async throws -> CardFormDraft {
        guard let status = cardFormTerminalTaskStatuses[taskId],
              let session = cardFormSession, scope.ownerId == bootstrap?.identity.id,
              scope.sessionId == session.sessionId else { throw CardFormDraftError.taskNotTerminal }
        let draft = try await session.startNextEntry(scope, taskId: taskId, status: status)
        cardFormActiveOperationId = nil
        cardFormActiveTaskId = nil
        // Keep the blocked owner text until attachCardFormToComposer proves
        // the owner explicitly reviewed a fresh entry.
        cardFormStateRevision += 1
        cardFormTaskRevision += 1
        return draft
    }

    func saveConnection(serverURL: String, token: String) async -> Bool {
        pairingAttemptVersion += 1
        let attempt = pairingAttemptVersion
        do {
            let configuration = try Self.configuration(urlString: serverURL, token: token)
            let candidate = client?.replacingConfiguration(configuration) ?? APIClient(configuration: configuration)
            let hadNativeFormProjection = candidate.nativeCardFormsEnabled
            let verified = try await candidate.bootstrap()
            guard !Task.isCancelled, attempt == pairingAttemptVersion else { return false }
            let normalized = configuration.baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let keepsCurrentSession = client?.configuration == configuration
                && bootstrap?.identity.id == verified.identity.id
            if !keepsCurrentSession {
                let sameCardFormPartition = cardFormSession?.serverIdentity == normalized
                    && cardFormSession?.ownerId == verified.identity.id
                    && hasKnownCardFormRecoveryFence
                connectionVersion += 1
                activityConnectionRevision += 1
                resetConnectedState(preserveCardFormRecoveryFence: sameCardFormPartition)
            }
            try await prepareCardFormSession(for: candidate, ownerId: verified.identity.id, pairingAttempt: attempt)
            guard !Task.isCancelled, attempt == pairingAttemptVersion else { return false }
            // Verify first: a failed candidate must preserve the existing
            // client, credential, owner state, and unsent conversation drafts.
            // A Keychain refusal must not reject a valid pairing. The token is
            // already held in the APIConfiguration for this session, so the
            // only real consequence is having to enter it again next launch —
            // reported after a successful connect rather than instead of one.
            var keychainWarning: String?
            do {
                try storeConnectionToken(token.trimmingCharacters(in: .whitespacesAndNewlines))
            } catch {
                keychainWarning = "Connected, but this device refused to store the key (\(error.localizedDescription)). You will need to enter it again next launch."
            }
            self.serverURL = normalized
            defaults.set(normalized, forKey: serverKey)
            client = candidate
            apply(verified, preservingLocalMessages: keepsCurrentSession && isSending)
            schedulePhoneCalendarSync(using: candidate, ownerID: verified.identity.id)
            showingConnection = false
            let version = connectionVersion
            await refreshConversationForNewlyEnabledForms(
                using: candidate, wasEnabled: hadNativeFormProjection, version: version
            )
            guard connectionIsCurrent(candidate, version: version) else { return false }
            await finishConnectionSetup(using: candidate, version: version)
            guard connectionIsCurrent(candidate, version: version) else { return false }
            if let keychainWarning { errorMessage = keychainWarning }
            return true
        } catch {
            guard !Task.isCancelled, attempt == pairingAttemptVersion else { return false }
            reportError(error)
        }
        return false
    }

    private var hasKnownCardFormRecoveryFence: Bool {
        !cardFormUnknownOperationIds.isEmpty
            || cardFormUnknownOperationId != nil
            || cardFormActiveOperationId != nil
            || cardFormActiveTaskId != nil
            || !cardFormActiveOwnerMessageTexts.isEmpty
    }

    private func resetConnectedState(preserveCardFormRecoveryFence: Bool = false) {
        phoneCalendarSyncRevision += 1
        phoneCalendarSyncTask?.cancel()
        phoneCalendarSyncTask = nil
        phoneCalendarEventDebounceTask?.cancel()
        phoneCalendarEventDebounceTask = nil
        _ = phoneCalendarEventDebounceRevision.advance()
        calendarPreflightRevision += 1
        isPreparingCalendarContext = false
        phoneCalendarSharing.cancelInFlightBinding()
        NotificationManager.shared.setRegistrationScope(nil)
        stopIdlePolling()
        pollTask?.cancel()
        pollTask = nil
        resumableTurn = nil
        ordinaryTurn = nil
        isCardFormAdmissionPending = false
        isCancellingSend = false
        cancelRequestedWithoutTaskID = false
        pendingNotificationDestination = nil
        notificationNavigationVersion += 1
        notificationTurnSettlements = NotificationTurnSettlements()
        approvalReconciliation?.cancel()
        approvalReconciliation = nil
        thoughtClearTask?.cancel()
        dismissHiddenMessageUndo()
        stopSpeaking()
        isSending = false
        isLoading = false
        nextMessageAutonomous = false
        activeConversation = nil
        bootstrap = nil
        sharedWorkspaceRead?.task.cancel()
        sharedWorkspaceRead = nil
        sharedOverviewRead?.task.cancel()
        sharedOverviewRead = nil
        memoryErasureToken = nil
        edits.reset()
        overview = nil
        archivedActivity = nil
        archivedGoals = nil
        workspace = nil
        modelProviders = nil
        mcpConnections = []
        mcpConnectionsLoaded = false
        savedCards = []
        cachedCalls = nil
        cachedSituationPacks = nil
        graphCache = [:]
        graphCacheRecency = []
        memoryLibraryRecency = []
        memoryReviewCount = 0
        people = []
        peopleLoaded = false
        personCards.removeAll()
        personProfiles.removeAll()
        acceptedApprovalDecisions.removeAll()
        approvalsBeingDecided.removeAll()
        suggestionsBeingAnswered.removeAll()
        suggestionAnswers.removeAll()
        cardsBeingRefreshed.removeAll()
        cardRefreshMarkers.removeAll()
        cardRefreshOperations.removeAll()
        messages = []
        logOrder.reset()
        cursor = nil
        activityThought = nil
        activityDetail = nil
        toolActivity = []
        lastNotifiedTaskState = nil
        lastLocationPostAt = nil
        lastForegroundReportAt = nil
        restorableDraft = nil
        packDiscussionDraft = nil
        cardFormComposerBinding = nil
        if !preserveCardFormRecoveryFence {
            cardFormUnknownOperationId = nil
            cardFormUnknownOperationIds.removeAll()
            cardFormActiveOperationId = nil
            cardFormActiveTaskId = nil
            cardFormActiveOwnerMessageTexts.removeAll()
            cardFormRecoveryReady = true
        } else {
            cardFormRecoveryReady = false
        }
        cardFormTaskRevision += 1
        cardFormTaskStatusObservers.values.forEach { $0.cancel() }
        cardFormTaskStatusObservers.removeAll()
        cardFormTaskObserverIDs.removeAll()
        cardFormTaskCursors.removeAll()
        cardFormPreparationVersion &+= 1
        cardFormTerminalTaskStatuses.removeAll()
        cardFormObservedTaskStatuses.removeAll()
        cardFormStateRevision += 1
        conversationDrafts.reset()
        composerRecoveryRevision += 1
        navigationPath = []
        dismissError()
    }

    /// Surface a failure, offering a retry only when the cause was the network.
    /// The message is set first so its `didSet` cannot clear the retry after.
    func reportError(_ error: Error, source: AssistantErrorSource? = nil, retry: RetryAction? = nil) {
        // Filter before touching either field: a cancelled background load must
        // not erase an unrelated actionable error or inherit its retry.
        guard !Task.isCancelled, !isRequestCancellation(error) else { return }
        errorMessage = error.localizedDescription
        errorNotice = AssistantErrorNotice(error: error)
        errorSource = source
        errorRetry = (error as? APIError)?.isTransport == true ? retry : nil
    }

    private func clearRecoveredError(from source: AssistantErrorSource) {
        // A recovered read can retire its own warning, never an unrelated
        // failed save or action that still needs the owner's attention.
        if errorSource == source { dismissError() }
    }

    func refreshAll(reportFailure: Bool = true) async {
        guard let client else { return }
        var version = connectionVersion
        let pairingAttempt = pairingAttemptVersion
        let overviewVersion = version
        let hadNativeFormProjection = client.nativeCardFormsEnabled
        client.disableNativeCardForms()
        // Kept separate for the same reason `connect()` separates them: these
        // fetch different things, and a failing dashboard query should not
        // throw away a bootstrap that arrived perfectly well.
        // Started together, handled separately: a failing dashboard query still
        // does not throw away a bootstrap that arrived perfectly well.
        async let overviewResult = fetchOverview(client)
        do {
            let response = try await client.bootstrap()
            guard connectionIsCurrent(client, version: version), pairingAttempt == pairingAttemptVersion else { return }
            if let existingOwner = bootstrap?.identity.id, existingOwner != response.identity.id {
                connectionVersion += 1
                activityConnectionRevision += 1
                resetConnectedState()
                version = connectionVersion
            }
            try await prepareCardFormSession(for: client, ownerId: response.identity.id, pairingAttempt: pairingAttempt)
            guard connectionIsCurrent(client, version: version), pairingAttempt == pairingAttemptVersion else { return }
            apply(response, preservingLocalMessages: isSending)
            version = connectionVersion
            clearRecoveredError(from: .bootstrap)
            await resolvePendingNotificationDestination()
            guard connectionIsCurrent(client, version: version) else { return }
            await refreshConversationForNewlyEnabledForms(
                using: client, wasEnabled: false, version: version
            )
        } catch {
            guard connectionIsCurrent(client, version: version), pairingAttempt == pairingAttemptVersion else { return }
            if hadNativeFormProjection,
               let session = cardFormSession,
               session.serverIdentity == client.configuration.baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
               session.ownerId == bootstrap?.identity.id {
                client.enableNativeCardForms()
            }
            if reportFailure {
                reportError(error, source: .bootstrap, retry: { [weak self] in
                    guard let self else { return }
                    await self.refreshAll()
                })
            }
            return
        }
        guard connectionIsCurrent(client, version: version) else { return }
        // Authentication may have replaced the owner behind an unchanged key.
        // Never promote the old speculative read into the replacement scope.
        let result = version == overviewVersion
            ? await overviewResult : await fetchOverview(client)
        applyOverviewResult(result, using: client, version: version, reportFailure: reportFailure)
        guard connectionIsCurrent(client, version: version) else { return }
        await reconcileBaselineActivity()
        guard connectionIsCurrent(client, version: version) else { return }
        await syncNotificationBadge()
    }

    /// One overview read as a value, so it can run beside another request and be
    /// judged on its own once the other has landed.
    private struct ScopedOverviewRead {
        let editRevision: Int
        let result: Result<OverviewResponse, Error>
    }

    private func fetchOverview(_ client: APIClient) async -> ScopedOverviewRead {
        let revision = edits.revision(for: [.overview])
        do { return ScopedOverviewRead(editRevision: revision, result: .success(try await client.overview())) }
        catch { return ScopedOverviewRead(editRevision: revision, result: .failure(error)) }
    }

    private func applyOverviewResult(_ read: ScopedOverviewRead,
                                     using client: APIClient, version: Int, reportFailure: Bool) {
        guard connectionIsCurrent(client, version: version), read.editRevision == edits.revision(for: [.overview]) else { return }
        do {
            overview = withLocalApprovalDecisions(try read.result.get())
            clearRecoveredError(from: .overview)
        } catch {
            if reportFailure {
                reportError(error, source: .overview, retry: { [weak self] in
                    guard let self else { return }
                    await self.refreshOverview()
                })
            }
        }
    }

    func scenePhaseDidChange(_ phase: ScenePhase) {
        // Only a real backgrounding tears down work. `.inactive` is also the
        // app switcher and a pulled-down Control Center, and cancelling a live
        // turn for those would be worse than the problem being solved.
        if phase == .background { didEnterBackground() }

        let isNowActive = phase == .active
        guard isSceneActive != isNowActive else { return }
        isSceneActive = isNowActive
        if isNowActive {
            edits.refreshConfirmed()
            discardStaleConnectionsIfNeeded()
            if let bootstrap {
                startIdlePolling()
                schedulePhoneCalendarSync(using: client, ownerID: bootstrap.identity.id)
            }
            resumeInterruptedTurn()
        } else {
            stopIdlePolling()
        }
    }

    func loadPhoneCalendarSharing() async {
        guard let client, let ownerID = bootstrap?.identity.id else {
            phoneCalendarSharing.cancelInFlightBinding()
            return
        }
        await phoneCalendarSharing.refresh(client: client, expectedOwnerID: ownerID, publishIfEnabled: false)
    }

    func refreshPhoneCalendarSharingSnapshot() async {
        guard let client, let ownerID = bootstrap?.identity.id else {
            phoneCalendarSharing.cancelInFlightBinding()
            return
        }
        await phoneCalendarSharing.refresh(client: client, expectedOwnerID: ownerID, publishIfEnabled: true)
    }

    func phoneCalendarEventsChanged() {
        phoneCalendarEventDebounceTask?.cancel()
        guard let client, let ownerID = bootstrap?.identity.id,
              isSceneActive, phoneCalendarSharing.isSharingEnabled else { return }
        let eventRevision = phoneCalendarEventDebounceRevision.advance()
        let version = connectionVersion
        phoneCalendarEventDebounceTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled, let self else { return }
            defer {
                if self.phoneCalendarEventDebounceRevision.owns(eventRevision) {
                    self.phoneCalendarEventDebounceTask = nil
                }
            }
            guard self.phoneCalendarEventDebounceRevision.owns(eventRevision),
                  self.connectionIdentityIsCurrent(client, version: version),
                  self.bootstrap?.identity.id == ownerID,
                  self.phoneCalendarSharing.isSharingEnabled else { return }
            let deadline = ContinuousClock.now + .seconds(5)
            while self.phoneCalendarSharing.isWorking, ContinuousClock.now < deadline {
                try? await Task.sleep(for: .milliseconds(50))
                guard !Task.isCancelled,
                      self.phoneCalendarEventDebounceRevision.owns(eventRevision),
                      self.connectionIdentityIsCurrent(client, version: version),
                      self.bootstrap?.identity.id == ownerID,
                      self.phoneCalendarSharing.isSharingEnabled else { return }
            }
            guard !self.phoneCalendarEventDebounceTaskIsCancelledOrStale(eventRevision: eventRevision),
                  self.connectionIdentityIsCurrent(client, version: version),
                  self.bootstrap?.identity.id == ownerID,
                  !self.phoneCalendarSharing.isWorking else { return }
            await self.phoneCalendarSharing.refresh(client: client, expectedOwnerID: ownerID, publishIfEnabled: true)
        }
    }

    private func phoneCalendarEventDebounceTaskIsCancelledOrStale(eventRevision: Int) -> Bool {
        Task.isCancelled || !phoneCalendarEventDebounceRevision.owns(eventRevision)
    }

    func startPhoneCalendarSharing(with calendars: [SharedPhoneCalendar], replace: Bool = false) async {
        guard let client, let ownerID = bootstrap?.identity.id else {
            phoneCalendarSharing.cancelInFlightBinding()
            return
        }
        if !phoneCalendarSharing.isOwnerVerified {
            await phoneCalendarSharing.refresh(client: client, expectedOwnerID: ownerID, publishIfEnabled: false)
        }
        await phoneCalendarSharing.enable(
            client: client, expectedOwnerID: ownerID,
            command: replace ? "replace" : "enable", selectedCalendars: calendars
        )
    }

    func stopPhoneCalendarSharing() async {
        guard let client, let ownerID = bootstrap?.identity.id else {
            phoneCalendarSharing.cancelInFlightBinding()
            return
        }
        if !phoneCalendarSharing.isOwnerVerified {
            await phoneCalendarSharing.refresh(client: client, expectedOwnerID: ownerID, publishIfEnabled: false)
        }
        await phoneCalendarSharing.disable(client: client, expectedOwnerID: ownerID)
    }

    private func schedulePhoneCalendarSync(using client: APIClient?, ownerID: String) {
        guard let client, !Task.isCancelled, phoneCalendarSyncTask == nil else { return }
        phoneCalendarSyncRevision += 1
        let revision = phoneCalendarSyncRevision
        phoneCalendarSyncTask = Task { [weak self] in
            guard let self else { return }
            await self.phoneCalendarSharing.refresh(client: client, expectedOwnerID: ownerID, publishIfEnabled: true)
            guard revision == self.phoneCalendarSyncRevision else { return }
            self.phoneCalendarSyncTask = nil
        }
    }

    private func didEnterBackground() {
        backgroundedAt = Date()
        // pollTask holds the SSE stream and the reply poll. Left running it is
        // suspended with the app, its socket dies unnoticed during suspension,
        // and it resurfaces as "The request timed out" the moment the owner
        // comes back. Cancel it here and resume from the cursor instead — the
        // server is still working on the turn either way.
        pollTask?.cancel()
        pollTask = nil
    }

    /// Runs before RootView's foreground refresh fires. That ordering is the
    /// point: otherwise the refresh is what discovers the dead socket, and
    /// discovering it that way costs a full timeout.
    private func discardStaleConnectionsIfNeeded() {
        guard let backgroundedAt else { return }
        self.backgroundedAt = nil
        guard Date().timeIntervalSince(backgroundedAt) >= Self.staleConnectionSeconds else { return }
        Transport.shared.reset()
    }

    /// A turn interrupted by backgrounding is still running on the server, so
    /// pick the reply up from the cursor rather than leaving the composer
    /// spinning against a task that no longer exists.
    private func resumeInterruptedTurn() {
        guard isSending, pollTask == nil, let turn = resumableTurn else { return }
        pollTask = Task { [weak self] in
            guard let self else { return }
            await self.pollForReply(taskId: turn.taskId, streamID: turn.streamID,
                ordinaryTurnToken: self.ordinaryTurn?.token)
        }
    }

    @discardableResult
    func refreshOverview(reportFailure: Bool = true) async -> Bool {
        guard let client else { return false }
        let version = connectionVersion
        let editRevision = edits.revision(for: [.overview])
        do {
            let request: Task<OverviewResponse, Error>
            let requestID: UUID
            if let shared = sharedOverviewRead, shared.version == version, shared.revision == editRevision {
                request = shared.task
                requestID = shared.id
            } else {
                request = Task { try await client.overview() }
                requestID = UUID()
                sharedOverviewRead = (version, editRevision, requestID, request)
            }
            defer { if sharedOverviewRead?.id == requestID { sharedOverviewRead = nil } }
            let response = try await request.value
            guard !Task.isCancelled else { return false }
            guard edits.revision(for: [.overview]) == editRevision, connectionIsCurrent(client, version: version) else { return false }
            overview = withLocalApprovalDecisions(response)
            documentPageError = nil
            clearRecoveredError(from: .overview)
            await reconcileBaselineActivity()
            guard connectionIsCurrent(client, version: version) else { return false }
            await syncNotificationBadge()
            guard connectionIsCurrent(client, version: version) else { return false }
            return true
        }
        catch where reportFailure {
            guard connectionIsCurrent(client, version: version) else { return false }
            reportError(error, source: .overview, retry: { [weak self] in
                guard let self else { return }
                await self.refreshOverview()
            })
            return false
        }
        catch { return false }
    }

    func fetchActivityStatus(id: String) async -> ActivityStatusResponse? {
        guard case let .updated(status) = await fetchActivityStatusOutcome(id: id) else { return nil }
        return status
    }

    func fetchActivityStatusOutcome(id: String) async -> ActivityStatusReadOutcome {
        guard !Task.isCancelled, let client else { return .discarded }
        let version = connectionVersion
        do {
            let status = try await client.activityStatus(id: id)
            guard !Task.isCancelled, connectionIsCurrent(client, version: version) else { return .discarded }
            guard status.id == id else { return .unavailable }
            return .updated(status)
        } catch {
            guard !Task.isCancelled, connectionIsCurrent(client, version: version) else { return .discarded }
            if isRequestCancellation(error) { return .discarded }
            return .unavailable
        }
    }

    func activityDiscoveryPage(archived: Bool, query: String, filter: String, cursor: String?) async -> ActivityList? {
        guard let client else { return nil }
        let version = connectionVersion
        do {
            let page = try await client.activity(archived: archived, query: query, filter: filter, cursor: cursor)
            guard connectionIsCurrent(client, version: version) else { return nil }
            return page
        } catch {
            guard connectionIsCurrent(client, version: version) else { return nil }
            reportError(error)
            return nil
        }
    }

    @discardableResult
    func refreshArchivedActivity(reportFailure: Bool = true) async -> Bool {
        guard let client else { return false }
        let version = connectionVersion
        do {
            let result = try await client.activity(archived: true)
            guard connectionIsCurrent(client, version: version) else { return false }
            archivedActivity = result
            return true
        }
        catch where reportFailure {
            guard connectionIsCurrent(client, version: version) else { return false }
            reportError(error)
            return false
        }
        catch { return false }
    }

    func refreshArchivedGoals(reportFailure: Bool = true) async {
        guard let client else { return }
        let version = connectionVersion
        do {
            let result = try await client.goals(archived: true)
            guard connectionIsCurrent(client, version: version) else { return }
            archivedGoals = result
        }
        catch where reportFailure {
            guard connectionIsCurrent(client, version: version) else { return }
            reportError(error)
        }
        catch { }
    }

    /// Mutations already have a successful server response. Let their control
    /// return immediately and reconcile secondary dashboards without turning a
    /// slow follow-up GET into a failed user action.
    private func reconcileAfterMutation(
        archivedActivity: Bool = false,
        archivedGoals: Bool = false
    ) {
        Task { [weak self] in
            guard let self else { return }
            async let overviewRefresh: Bool = self.refreshOverview(reportFailure: false)
            async let activityRefresh: Bool = archivedActivity
                ? self.refreshArchivedActivity(reportFailure: false)
                : false
            async let goalsRefresh: Void = archivedGoals
                ? self.refreshArchivedGoals(reportFailure: false)
                : ()
            _ = await (overviewRefresh, activityRefresh, goalsRefresh)
        }
    }

    func updateActivity(_ item: ActivityItem, action: String) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateActivity(id: item.id, action: action)
            reconcileAfterMutation(archivedActivity: true)
            return true
        } catch {
            reportError(error)
            return false
        }
    }

    func updateActivity(_ item: ActivityItem, action: String, budgetUsdLimit: Double?) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateActivity(
                id: item.id,
                action: action,
                budgetUsdLimit: budgetUsdLimit
            )
            reconcileAfterMutation()
            return true
        } catch {
            reportError(error)
            return false
        }
    }

    func archiveOldActivity(operationId: String? = nil) async -> ArchiveOldActivityProgress? {
        guard let client else { return nil }
        errorMessage = nil
        do {
            let progress = try await client.archiveOldActivity(operationId: operationId)
            reconcileAfterMutation(archivedActivity: true)
            return progress
        } catch {
            reportError(error)
            return nil
        }
    }

    /// Acceptance is synchronous; the app owns the write after the editor closes.
    /// Only edits with a deterministic local projection use this path.
    private func enqueueEdit(
        _ title: String, draft: String = "", resources: Set<MobileEditResource>, retrySafe: Bool = true,
        patch: @escaping OptimisticEditStore.Patch,
        write: @escaping @MainActor (APIClient) async throws -> Void
    ) -> Bool {
        guard let client else {
            errorMessage = "Connect to your assistant before saving."
            return false
        }
        guard memoryErasureToken == nil || !resources.contains(.memory) else {
            errorMessage = "Memory erasure is still finishing. Try again when it completes."
            return false
        }
        let version = connectionVersion
        edits.reconcile = { [weak self] resources in
            guard let self, self.connectionIsCurrent(client, version: version) else { return false }
            return await self.reconcileEdits(resources)
        }
        edits.submit(title: title, draft: draft, resources: resources, retrySafe: retrySafe, patch: patch) { [weak self] in
            guard let self, self.connectionIsCurrent(client, version: version) else { throw CancellationError() }
            try await write(client)
            guard self.connectionIsCurrent(client, version: version) else { throw CancellationError() }
        }
        return true
    }

    private func reconcileEdits(_ resources: Set<MobileEditResource>) async -> Bool {
        async let workspaceRead = resources.contains(.workspace) ? refreshWorkspace(reportFailure: false) : true
        async let overviewRead = resources.contains(.overview) ? refreshOverview(reportFailure: false) : true
        async let providersRead = resources.contains(.providers) ? refreshModelProviders(reportFailure: false) : true
        async let cardsRead = resources.contains(.cards) ? refreshCards(reportFailure: false) : true
        async let peopleRead = reconcilePeopleEdits(resources)
        async let commitmentsRead = resources.contains(.commitments) ? reloadCommitments() : true
        async let archiveRead = resources.contains(.archivedGoals) ? reloadArchivedGoals() : true
        async let libraryRead = reconcileMemoryLibraries(resources)
        async let voiceRead = resources.contains(.voiceProfile) ? reloadVoiceProfile() : true
        let results = await [workspaceRead, overviewRead, providersRead, cardsRead, peopleRead, commitmentsRead, libraryRead, voiceRead, archiveRead]
        return results.allSatisfy { $0 }
    }

    private func reconcilePeopleEdits(_ resources: Set<MobileEditResource>) async -> Bool {
        guard let client else { return false }
        let version = connectionVersion
        let readResources = resources.filter { resource in
            switch resource {
            case .people, .personCaches, .person: true
            default: false
            }
        }
        let revision = edits.revision(for: readResources)
        do {
            if resources.contains(.people) {
                let response = try await client.people()
                guard connectionIsCurrent(client, version: version), edits.revision(for: readResources) == revision else { return false }
                people = response.people
                peoplePagination = response.pagination.flatMap { $0.isSupported ? $0 : nil }
                peopleGeneration = response.generatedAt
                peopleLoaded = true
            }
            for resource in resources {
                guard case let .person(id) = resource else { continue }
                async let profile = client.personProfile(id: id)
                async let card = client.personCard(id: id)
                let (loadedProfile, loadedCard) = try await (profile, card)
                guard connectionIsCurrent(client, version: version), edits.revision(for: readResources) == revision else { return false }
                edits.updateRemote(resources: [.person(id)]) { state in
                    state.personProfiles[id] = loadedProfile
                    state.personCards[id] = loadedCard
                }
            }
            return true
        } catch { return false }
    }

    private func reloadArchivedGoals() async -> Bool {
        guard let client else { return false }
        let version = connectionVersion
        let revision = edits.revision(for: [.archivedGoals])
        do {
            let response = try await client.goals(archived: true)
            guard connectionIsCurrent(client, version: version), edits.revision(for: [.archivedGoals]) == revision else { return false }
            archivedGoals = response
            return true
        } catch { return false }
    }

    private func reloadCommitments() async -> Bool {
        guard let client else { return false }
        let version = connectionVersion
        let revision = edits.revision(for: [.commitments])
        do {
            let response = try await client.commitments()
            guard connectionIsCurrent(client, version: version), edits.revision(for: [.commitments]) == revision else { return false }
            edits.updateRemote(resources: [.commitments]) { $0.commitments = response.commitments }
            return true
        } catch { return false }
    }

    private func reconcileMemoryLibraries(_ resources: Set<MobileEditResource>) async -> Bool {
        for resource in resources {
            if case let .library(query) = resource, cachedMemoryLibrary(query) != nil, await memoryLibrary(query, reportFailure: false, updateRecency: false) == nil { return false }
        }
        return true
    }

    private var memoryEditResources: Set<MobileEditResource> {
        Set(edits.visible.memoryLibraries.keys.map { MobileEditResource.library($0) }).union([.workspace, .memory])
    }

    func cachedMemoryLibrary(_ query: MemoryLibraryQuery) -> MemoryLibraryResponse? {
        edits.visible.memoryLibraries[query]
    }

    var cachedVoiceProfile: VoiceProfileResponse? { edits.visible.voiceProfile }

    private func reloadVoiceProfile() async -> Bool {
        guard let client else { return false }
        let version = connectionVersion
        let revision = edits.revision(for: [.voiceProfile])
        do {
            let response = try await client.voiceProfile()
            guard connectionIsCurrent(client, version: version), edits.revision(for: [.voiceProfile]) == revision else { return false }
            edits.updateRemote(resources: [.voiceProfile]) { $0.voiceProfile = response }
            return true
        } catch { return false }
    }

    var cachedCommitments: [Commitment]? { edits.visible.commitments }

    private func goalDraft(_ goal: GoalMutation) -> String {
        [goal.title, goal.description, "Priority: \(goal.priority)",
         "Target date: " + (goal.targetDate ?? "None"), "Progress: " + goal.progress,
         "Next action: " + goal.nextAction,
         "Updates in main chat: " + (goal.mirrorToPrimary ? "Yes" : "No")].joined(separator: "\n")
    }

    func createGoal(_ goal: GoalMutation) async -> Bool {
        let id = "local:" + UUID().uuidString
        let now = Date().ISO8601Format()
        return enqueueEdit("New goal", draft: goalDraft(goal), resources: [.overview], retrySafe: false, patch: { state in
            let record = GoalRecord(id: id, title: goal.title, description: goal.description, status: "active",
                priority: goal.priority, progress: goal.progress, nextAction: goal.nextAction,
                targetDate: goal.targetDate, createdAt: now, updatedAt: now, archivedAt: nil,
                mirrorToPrimary: goal.mirrorToPrimary, autonomy: false, taintedOrigin: false)
            state.overview?.goals.items.removeAll { $0.id == id }
            state.overview?.goals.items.insert(GoalDashboardItem(goal: record, conversationId: nil,
                workActive: false, automation: nil, cadenceLabel: "", blockedQuestion: "", stalled: false), at: 0)
        }) { try await $0.createGoal(goal) }
    }

    func updateGoal(id: String, goal: GoalMutation) async -> Bool {
        guard !id.hasPrefix("local:") else { return false }
        return enqueueEdit("Goal changes", draft: goalDraft(goal), resources: [.overview], patch: { state in
            guard let index = state.overview?.goals.items.firstIndex(where: { $0.id == id }) else { return }
            state.overview?.goals.items[index].goal.title = goal.title
            state.overview?.goals.items[index].goal.description = goal.description
            state.overview?.goals.items[index].goal.priority = goal.priority
            state.overview?.goals.items[index].goal.progress = goal.progress
            state.overview?.goals.items[index].goal.nextAction = goal.nextAction
            state.overview?.goals.items[index].goal.targetDate = goal.targetDate
            state.overview?.goals.items[index].goal.mirrorToPrimary = goal.mirrorToPrimary
        }) { try await $0.updateGoal(id: id, goal: goal) }
    }

    /// Mobile “delete” matches the web goal UI: archive the goal while
    /// retaining its work conversation and evidence for later restoration.
    func deleteGoal(_ goal: GoalRecord) async -> Bool {
        guard !goal.id.hasPrefix("local:") else { return false }
        return enqueueEdit("Archive goal", draft: goal.title, resources: [.overview, .archivedGoals], patch: { state in
            if var item = state.overview?.goals.items.first(where: { $0.id == goal.id }) {
                item.goal.archivedAt = Date().ISO8601Format()
                state.archivedGoals?.items.removeAll { $0.id == goal.id }
                state.archivedGoals?.items.insert(item, at: 0)
            }
            state.overview?.goals.items.removeAll { $0.id == goal.id }
        }) { try await $0.updateGoal(id: goal.id, action: "delete") }
    }

    func restoreGoal(_ goal: GoalRecord) async -> Bool {
        return enqueueEdit("Restore goal", draft: goal.title, resources: [.overview, .archivedGoals], patch: { state in
            if var item = state.archivedGoals?.items.first(where: { $0.id == goal.id }) {
                item.goal.archivedAt = nil
                state.overview?.goals.items.removeAll { $0.id == goal.id }
                state.overview?.goals.items.insert(item, at: 0)
            }
            state.archivedGoals?.items.removeAll { $0.id == goal.id }
        }) { try await $0.updateGoal(id: goal.id, action: "restore") }
    }

    func updateGoalLifecycle(
        _ goal: GoalRecord, action: String, status: String? = nil, enabled: Bool? = nil
    ) async -> Bool {
        guard !goal.id.hasPrefix("local:") else { return false }
        // Starting/stopping work has a server outcome, unlike editing the
        // goal's fields. Existing progress stays visible while it is pending.
        if action == "start" || action == "stop" {
            guard let client else { return false }
            do {
                try await client.updateGoal(id: goal.id, action: action, status: status, enabled: enabled)
                reconcileAfterMutation()
                return true
            } catch { reportError(error); return false }
        }
        return enqueueEdit("Goal status", draft: goal.title + "\n" + (status ?? action), resources: [.overview], patch: { state in
            guard let index = state.overview?.goals.items.firstIndex(where: { $0.id == goal.id }) else { return }
            if let status { state.overview?.goals.items[index].goal.status = status }
            if let enabled, action == "autonomy" { state.overview?.goals.items[index].goal.autonomy = enabled }
        }) { try await $0.updateGoal(id: goal.id, action: action, status: status, enabled: enabled) }
    }

    func archiveInactiveGoals() async -> Bool {
        let cutoff = Date().addingTimeInterval(-30 * 24 * 60 * 60)
        let formatter = ISO8601DateFormatter()
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let ids = Set((overview?.goals.items ?? []).filter { item in
            guard ["done", "abandoned"].contains(item.goal.status), !item.workActive,
                  let updated = fractional.date(from: item.goal.updatedAt) ?? formatter.date(from: item.goal.updatedAt) else { return false }
            return updated < cutoff
        }.prefix(100).map(\.id))
        return enqueueEdit("Archive inactive goals", resources: [.overview, .archivedGoals], patch: { state in
            state.overview?.goals.items.removeAll { ids.contains($0.id) }
        }) { try await $0.archiveInactiveGoals() }
    }

    func openConversation(id: String) async -> Bool {
        guard let client else { return false }
        guard !isSending, !notificationTurnSettlements.isSettling else {
            errorMessage = "Let this reply finish or stop it before switching conversations."
            return false
        }
        notificationNavigationVersion += 1
        pendingNotificationDestination = nil
        let version = notificationNavigationVersion
        let ownerID = bootstrap?.identity.id
        errorMessage = nil
        // An undo offer belongs to the thread it was made in.
        dismissHiddenMessageUndo()
        do {
            let conversation = try await client.conversation(id: id)
            guard !Task.isCancelled, version == notificationNavigationVersion,
                  !isSending, !notificationTurnSettlements.isSettling,
                  self.client?.configuration == client.configuration,
                  bootstrap?.identity.id == ownerID else { return false }
            setActiveConversation(conversation)
            returnToChat()
            return true
        } catch {
            guard !Task.isCancelled, version == notificationNavigationVersion,
                  !isSending, !notificationTurnSettlements.isSettling,
                  self.client?.configuration == client.configuration,
                  bootstrap?.identity.id == ownerID else { return false }
            reportError(error)
            return false
        }
    }

    func createConversation() async -> Bool {
        guard let client else { return false }
        guard !isSending, !notificationTurnSettlements.isSettling else {
            errorMessage = "Let this reply finish or stop it before creating a conversation."
            return false
        }
        let version = connectionVersion
        let ownerID = bootstrap?.identity.id
        notificationNavigationVersion += 1
        pendingNotificationDestination = nil
        let navigationVersion = notificationNavigationVersion
        errorMessage = nil
        do {
            let created = try await client.createChat()
            guard connectionIsCurrent(client, version: version),
                  !isSending, !notificationTurnSettlements.isSettling,
                  bootstrap?.identity.id == ownerID,
                  notificationNavigationVersion == navigationVersion else { return false }
            return await openConversation(id: created.conversationId)
        } catch {
            guard connectionIsCurrent(client, version: version),
                  !isSending, !notificationTurnSettlements.isSettling,
                  bootstrap?.identity.id == ownerID,
                  notificationNavigationVersion == navigationVersion else { return false }
            reportError(error)
            return false
        }
    }

    func archiveInactiveConversations() async -> Bool {
        guard let client else { return false }
        do {
            try await client.archiveInactiveChats()
            await refreshWorkspace(reportFailure: false)
            return true
        } catch {
            reportError(error)
            return false
        }
    }

    func updateConversation(_ chat: WorkspaceChat, action: String) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateChat(id: chat.id, action: action)
            if action == "archive", conversationId == chat.id {
                activeConversation = nil
                await refreshAll()
            }
            await refreshWorkspace(reportFailure: false)
            return true
        } catch {
            reportError(error)
            return false
        }
    }

    func changeConversationModel(_ modelId: String?) async -> Bool {
        guard let client, let conversationId else { return false }
        guard !isSending, !notificationTurnSettlements.isSettling else {
            errorMessage = "Let this reply finish or stop it before changing models."
            return false
        }
        let version = connectionVersion
        let ownerID = bootstrap?.identity.id
        let navigationVersion = notificationNavigationVersion
        errorMessage = nil
        do {
            try await client.updateChat(id: conversationId, action: "change-model", modelId: modelId)
            guard connectionIsCurrent(client, version: version), !isSending, !notificationTurnSettlements.isSettling,
                  bootstrap?.identity.id == ownerID,
                  self.conversationId == conversationId,
                  notificationNavigationVersion == navigationVersion else { return false }
            let updated = try await client.conversation(id: conversationId)
            guard connectionIsCurrent(client, version: version), !isSending, !notificationTurnSettlements.isSettling,
                  bootstrap?.identity.id == ownerID,
                  self.conversationId == conversationId,
                  notificationNavigationVersion == navigationVersion else { return false }
            guard updated.conversation.id.lowercased() == conversationId.lowercased() else { throw APIError.invalidResponse }
            setActiveConversation(updated)
            return true
        } catch {
            guard connectionIsCurrent(client, version: version), !isSending, !notificationTurnSettlements.isSettling,
                  bootstrap?.identity.id == ownerID,
                  self.conversationId == conversationId,
                  notificationNavigationVersion == navigationVersion else { return false }
            reportError(error)
            return false
        }
    }

    /// Take a message out of the log. The server keeps the row and skips it on
    /// every read, so the log is the owner's to curate without losing history:
    /// a reply that was wrong, a thread of tests, an answer three screens long.
    /// Removed here first — the gesture should feel immediate — and put back if
    /// the server refuses, which is the only way this can be wrong.
    func setRecallSourceSuppressed(
        conversationId: String,
        messageId: String,
        source: MessageRecallSource,
        suppressed: Bool
    ) async -> RecallSourceControlOutcome {
        guard source.hasCurrentLedgerReference,
              let surfaceKey = source.surfaceKey,
              let sourceRevision = source.sourceRevision,
              let client,
              self.conversationId == conversationId,
              let current = messages.first(where: { $0.id == messageId }),
              current.isDurableLogRow,
              current.recallSources.contains(where: {
                  $0.surfaceKey == surfaceKey && $0.sourceRevision == sourceRevision
              }) else { return .stale }

        let version = connectionVersion
        let ownerID = bootstrap?.identity.id
        do {
            try await client.setRecallSourceSuppressed(
                surfaceKey: surfaceKey,
                sourceRevision: sourceRevision,
                suppressed: suppressed
            )
            guard connectionIsCurrent(client, version: version),
                  bootstrap?.identity.id == ownerID,
                  self.conversationId == conversationId,
                  messages.contains(where: { message in
                      message.id == messageId && message.recallSources.contains(where: {
                          $0.surfaceKey == surfaceKey && $0.sourceRevision == sourceRevision
                      })
                  }) else { return .discarded }
            return .updated
        } catch APIError.server(status: 409, message: _) {
            return .stale
        } catch {
            return .failed
        }
    }

    func recallSourceSuppressed(
        conversationId: String,
        messageId: String,
        source: MessageRecallSource
    ) async -> Bool? {
        guard source.hasCurrentLedgerReference,
              let surfaceKey = source.surfaceKey,
              let sourceRevision = source.sourceRevision,
              let client,
              self.conversationId == conversationId,
              messages.contains(where: { message in
                  message.id == messageId && message.isDurableLogRow && message.recallSources.contains(where: {
                      $0.surfaceKey == surfaceKey && $0.sourceRevision == source.sourceRevision
                  })
              }) else { return nil }
        let version = connectionVersion
        let ownerID = bootstrap?.identity.id
        do {
            let suppressed = try await client.recallSourceSuppressed(
                surfaceKey: surfaceKey,
                sourceRevision: sourceRevision
            )
            guard connectionIsCurrent(client, version: version),
                  bootstrap?.identity.id == ownerID,
                  self.conversationId == conversationId,
                  messages.contains(where: { message in
                      message.id == messageId && message.isDurableLogRow && message.recallSources.contains(where: {
                          $0.surfaceKey == surfaceKey && $0.sourceRevision == source.sourceRevision
                      })
                  }) else { return nil }
            return suppressed
        } catch {
            return nil
        }
    }

    func hideMessage(_ message: ChatMessage) async {
        guard let client, let conversationId, message.isDurableLogRow else { return }
        guard let index = messages.firstIndex(where: { $0.id == message.id }) else { return }
        let version = connectionVersion
        let ownerID = bootstrap?.identity.id
        let removed = messages.remove(at: index)
        // A row taken out of the log should not keep talking from inside it.
        SpeechPlayer.shared.stop(messageID: message.id)
        do {
            try await client.setMessageHidden(
                conversationId: conversationId,
                messageId: message.id,
                hidden: true
            )
            guard connectionVersion == version, self.client?.configuration == client.configuration,
                  bootstrap?.identity.id == ownerID, self.conversationId == conversationId else { return }
            hiddenMessageUndo = HiddenMessageUndo(messageId: message.id, conversationId: conversationId)
            scheduleHiddenMessageUndoExpiry()
        } catch {
            // Cancellation still restores an unconfirmed local removal, but
            // only in the exact owner/session/conversation where it occurred.
            guard connectionVersion == version, self.client?.configuration == client.configuration,
                  bootstrap?.identity.id == ownerID, self.conversationId == conversationId else { return }
            // The log is the record; a hide the server never took must not
            // leave a hole in it. Back where it was, by id — an arriving poll
            // may have moved the rows either side of it in the meantime.
            if !messages.contains(where: { $0.id == removed.id }) {
                messages.insert(removed, at: min(index, messages.count))
                messages = logOrder.ordered(messages)
            }
            reportError(error)
        }
    }

    /// Persist an acknowledgement only after the native chat row is visible.
    /// The bounded retry handles the short interval between reply persistence
    /// and the task's terminal `done` transition; replay is idempotent server-side.
    func acknowledgeMessageDelivery(conversationId: String, messageId: String) async -> Bool {
        guard let client, self.conversationId == conversationId else { return false }
        let version = connectionVersion
        let ownerID = bootstrap?.identity.id
        for attempt in 0..<6 {
            if attempt > 0 {
                try? await Task.sleep(nanoseconds: UInt64(250_000_000 * (1 << min(attempt - 1, 4))))
            }
            guard connectionVersion == version,
                  self.client?.configuration == client.configuration,
                  bootstrap?.identity.id == ownerID,
                  self.conversationId == conversationId else { return false }
            do {
                try await client.acknowledgeMessageDelivery(
                    conversationId: conversationId,
                    messageId: messageId
                )
                return true
            } catch {
                continue
            }
        }
        return false
    }

    /// Put the last hidden message back. The thread is re-read rather than
    /// patched: the message belongs wherever the server says it does, and
    /// anything that landed while the bar was on screen belongs there too.
    func undoHiddenMessage() async {
        guard let client, let undo = hiddenMessageUndo else { return }
        let connectionRevision = connectionVersion
        let ownerID = bootstrap?.identity.id
        let navigationRevision = notificationNavigationVersion
        let intentGeneration = conversationIntentGeneration
        let conversationID = undo.conversationId
        hiddenMessageUndo = nil
        hiddenMessageUndoExpiry?.cancel()
        hiddenMessageUndoExpiry = nil
        do {
            try await client.setMessageHidden(
                conversationId: undo.conversationId,
                messageId: undo.messageId,
                hidden: false
            )
            // A reload during a turn would throw away the stream in flight.
            // The message is unhidden either way and returns on the next read.
            guard connectionIsCurrent(client, version: connectionRevision),
                  bootstrap?.identity.id == ownerID,
                  notificationNavigationVersion == navigationRevision,
                  conversationIntentGeneration == intentGeneration,
                  !isSending, self.conversationId == conversationID else { return }
            let restored = try await client.conversation(id: conversationID)
            guard connectionIsCurrent(client, version: connectionRevision),
                  bootstrap?.identity.id == ownerID,
                  notificationNavigationVersion == navigationRevision,
                  conversationIntentGeneration == intentGeneration,
                  !isSending, self.conversationId == conversationID else { return }
            setActiveConversation(restored)
        } catch {
            guard connectionIsCurrent(client, version: connectionRevision),
                  bootstrap?.identity.id == ownerID,
                  notificationNavigationVersion == navigationRevision,
                  conversationIntentGeneration == intentGeneration,
                  self.conversationId == conversationID else { return }
            reportError(error)
        }
    }

    func dismissHiddenMessageUndo() {
        hiddenMessageUndo = nil
        hiddenMessageUndoExpiry?.cancel()
        hiddenMessageUndoExpiry = nil
    }

    /// The offer is a courtesy for the tap that was a mistake, not a control
    /// that lives in the chat. It goes away on its own.
    private func scheduleHiddenMessageUndoExpiry() {
        hiddenMessageUndoExpiry?.cancel()
        let id = hiddenMessageUndo?.id
        hiddenMessageUndoExpiry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.hiddenMessageUndoSeconds))
            guard !Task.isCancelled, let self, self.hiddenMessageUndo?.id == id else { return }
            self.hiddenMessageUndo = nil
        }
    }

    /// Requests currently out for the workspace projection, so a prefetch never
    /// duplicates the read a screen has just started.
    @ObservationIgnored private var sharedWorkspaceRead: (version: Int, revision: Int, id: UUID, task: Task<WorkspaceResponse, Error>)?
    @ObservationIgnored private var sharedOverviewRead: (version: Int, revision: Int, id: UUID, task: Task<OverviewResponse, Error>)?
    @ObservationIgnored private var workspaceRequestsInFlight: [Int: Int] = [:]

    /// Warm the workspace once the conversation is up. Memory, Settings, Costs,
    /// Skills and the rest all draw on this one large projection, and the first
    /// screen to open used to start it cold: the owner tapped, then waited for
    /// the heaviest read the app makes. Bootstrap finishes first; secondary
    /// requests then start immediately and coalesce with any opened page.
    func prefetchSecondaryScreens() async {
        guard let client else { return }
        let version = connectionVersion
        guard connectionIsCurrent(client, version: version) else { return }
        async let workspaceRead = workspace == nil ? refreshWorkspace(reportFailure: false) : true
        async let peopleRead: Void = peopleLoaded ? () : loadPeople()
        _ = await (workspaceRead, peopleRead)
    }

    @discardableResult
    func refreshWorkspace(reportFailure: Bool = true) async -> Bool {
        guard let client else { return false }
        let version = connectionVersion
        let editRevision = edits.revision(for: [.workspace])
        workspaceRequestsInFlight[version, default: 0] += 1
        defer {
            let remaining = workspaceRequestsInFlight[version, default: 1] - 1
            if remaining == 0 { workspaceRequestsInFlight.removeValue(forKey: version) }
            else { workspaceRequestsInFlight[version] = remaining }
        }
        do {
            let request: Task<WorkspaceResponse, Error>
            let requestID: UUID
            if let shared = sharedWorkspaceRead, shared.version == version, shared.revision == editRevision {
                request = shared.task
                requestID = shared.id
            } else {
                request = Task { try await client.workspace() }
                requestID = UUID()
                sharedWorkspaceRead = (version, editRevision, requestID, request)
            }
            defer { if sharedWorkspaceRead?.id == requestID { sharedWorkspaceRead = nil } }
            let loaded = try await request.value
            guard !Task.isCancelled else { return false }
            guard edits.revision(for: [.workspace]) == editRevision, connectionIsCurrent(client, version: version) else { return false }
            workspace = loaded
            clearRecoveredError(from: .workspace)
            applyMemoryHealth(loaded.memory.health)
            return true
        } catch {
            guard connectionIsCurrent(client, version: version) else { return false }
            if reportFailure { reportError(error, source: .workspace) }
            return false
        }
    }

    @discardableResult
    func loadMoreWorkspace(_ section: WorkspacePageSection, archived: Bool = false) async -> Bool {
        guard let client, let initial = edits.serverSnapshot.workspace, let index = initial.sectionPagination else { return false }
        let connection = connectionVersion
        let ownerID = bootstrap?.identity.id
        let workspaceGeneration = initial.generatedAt
        let key = section == .chats ? "chats-\(archived ? "archived" : "current")" : section.rawValue
        guard !workspacePagesLoading.contains(key) else { return false }
        let pagination: WorkspaceSectionPagination?
        if section == .chats {
            pagination = archived ? index.chats?.archived : index.chats?.current
        } else {
            switch section {
            case .skills: pagination = index.skills
            case .anomalies: pagination = index.anomalies
            case .improvements: pagination = index.improvements
            case .chats: pagination = nil
            case .importSources: pagination = index.importSources
            case .importFiles: pagination = index.importFiles
            }
        }
        guard let pagination, pagination.pageSize == 50, pagination.hasMore,
              let cursor = pagination.nextCursor else { return false }
        if section == .importSources && pagination.consistency != "live-keyset" { return false }
        if section == .importFiles && !["process-snapshot", "provider-token"].contains(pagination.consistency ?? "") {
            return false
        }

        workspacePagesLoading.insert(key)
        defer { workspacePagesLoading.remove(key) }
        workspacePageErrors.removeValue(forKey: key)
        do {
            func update(_ current: WorkspaceSectionPagination, count: Int, response: WorkspacePageResponseMetadata) -> WorkspaceSectionPagination {
                var updated = current
                updated.loaded = count
                updated.consistency = response.consistency
                updated.hasMore = response.hasMore
                updated.complete = response.complete
                updated.nextCursor = response.nextCursor
                return updated
            }
            func isCurrent(_ response: WorkspacePageResponseMetadata, sectionName: String, actualSection: String) -> Bool {
                guard connectionIsCurrent(client, version: connection),
                      bootstrap?.identity.id == ownerID,
                      let current = edits.serverSnapshot.workspace, current.generatedAt == workspaceGeneration,
                      let currentIndex = current.sectionPagination else { return false }
                let currentPagination: WorkspaceSectionPagination?
                if section == .chats {
                    currentPagination = archived ? currentIndex.chats?.archived : currentIndex.chats?.current
                } else {
                    switch section {
                    case .skills: currentPagination = currentIndex.skills
                    case .anomalies: currentPagination = currentIndex.anomalies
                    case .improvements: currentPagination = currentIndex.improvements
                    case .chats: currentPagination = nil
                    case .importSources: currentPagination = currentIndex.importSources
                    case .importFiles: currentPagination = currentIndex.importFiles
                    }
                }
                let expectedConsistency: String
                switch section {
                case .importFiles:
                    expectedConsistency = currentIndex.importFiles?.consistency ?? ""
                case .importSources:
                    expectedConsistency = "live-keyset"
                default:
                    expectedConsistency = "live-keyset"
                }
                return actualSection == sectionName
                    && response.version == 1
                    && response.consistency == expectedConsistency
                    && response.pageSize == 50
                    && response.hasMore == (response.nextCursor != nil)
                    && response.complete == !response.hasMore
                    && (response.nextCursor == nil || response.nextCursor != cursor)
                    && (currentPagination?.nextCursor == cursor)
            }
            func appendUnique<Item: Identifiable>(_ incoming: [Item], to existing: inout [Item]) where Item.ID == String {
                var ids = Set(existing.map(\.id))
                for item in incoming where ids.insert(item.id).inserted {
                    existing.append(item)
                }
            }
            switch section {
            case .chats:
                let page: WorkspaceSectionPage<WorkspaceChat> = try await client.workspacePage(
                    section: .chats, cursor: cursor, archived: archived
                )
                guard page.availability.isAvailable,
                      page.items.count <= page.pagination.pageSize,
                      isCurrent(page.pagination, sectionName: section.rawValue, actualSection: page.section),
                      var loaded = edits.serverSnapshot.workspace else {
                    throw APIError.invalidResponse
                }
                if archived {
                    appendUnique(page.items, to: &loaded.chats.archived)
                    if var chatPages = loaded.sectionPagination?.chats {
                        chatPages.archived = update(chatPages.archived, count: loaded.chats.archived.count, response: page.pagination)
                        loaded.sectionPagination?.chats = chatPages
                    }
                } else {
                    appendUnique(page.items, to: &loaded.chats.current)
                    if var chatPages = loaded.sectionPagination?.chats {
                        chatPages.current = update(chatPages.current, count: loaded.chats.current.count, response: page.pagination)
                        loaded.sectionPagination?.chats = chatPages
                    }
                }
                workspace = loaded
            case .skills:
                let page: WorkspaceSectionPage<WorkspaceSkill> = try await client.workspacePage(section: section, cursor: cursor)
                guard page.availability.isAvailable, page.items.count <= page.pagination.pageSize,
                      isCurrent(page.pagination, sectionName: section.rawValue, actualSection: page.section),
                      var loaded = edits.serverSnapshot.workspace else {
                    throw APIError.invalidResponse
                }
                appendUnique(page.items, to: &loaded.skills)
                if let current = loaded.sectionPagination?.skills {
                    loaded.sectionPagination?.skills = update(current, count: loaded.skills.count, response: page.pagination)
                }
                workspace = loaded
            case .anomalies:
                let page: WorkspaceSectionPage<WorkspaceAnomaly> = try await client.workspacePage(section: section, cursor: cursor)
                guard page.availability.isAvailable, page.items.count <= page.pagination.pageSize,
                      isCurrent(page.pagination, sectionName: section.rawValue, actualSection: page.section),
                      var loaded = edits.serverSnapshot.workspace else {
                    throw APIError.invalidResponse
                }
                appendUnique(page.items, to: &loaded.anomalies)
                if let current = loaded.sectionPagination?.anomalies {
                    loaded.sectionPagination?.anomalies = update(current, count: loaded.anomalies.count, response: page.pagination)
                }
                workspace = loaded
            case .improvements:
                let page: WorkspaceSectionPage<WorkspaceImprovement> = try await client.workspacePage(section: section, cursor: cursor)
                guard page.availability.isAvailable, page.items.count <= page.pagination.pageSize,
                      isCurrent(page.pagination, sectionName: section.rawValue, actualSection: page.section),
                      var loaded = edits.serverSnapshot.workspace else {
                    throw APIError.invalidResponse
                }
                appendUnique(page.items, to: &loaded.improvements)
                if let current = loaded.sectionPagination?.improvements {
                    loaded.sectionPagination?.improvements = update(current, count: loaded.improvements.count, response: page.pagination)
                }
                workspace = loaded
            case .importSources:
                let page: WorkspaceSectionPage<WorkspaceImportSource> = try await client.workspacePage(
                    section: section, cursor: cursor
                )
                guard page.availability.isAvailable, page.items.count <= page.pagination.pageSize,
                      isCurrent(page.pagination, sectionName: section.rawValue, actualSection: page.section),
                      var loaded = edits.serverSnapshot.workspace, var imports = loaded.imports else {
                    throw APIError.invalidResponse
                }
                appendUnique(page.items, to: &imports.sources)
                loaded.imports = imports
                if let current = loaded.sectionPagination?.importSources {
                    loaded.sectionPagination?.importSources = update(current, count: imports.sources.count, response: page.pagination)
                }
                workspace = loaded
            case .importFiles:
                let page: WorkspaceSectionPage<WorkspaceImportFile> = try await client.workspacePage(
                    section: section, cursor: cursor
                )
                guard page.availability.isAvailable, page.items.count <= page.pagination.pageSize,
                      isCurrent(page.pagination, sectionName: section.rawValue, actualSection: page.section),
                      var loaded = edits.serverSnapshot.workspace, var imports = loaded.imports else {
                    throw APIError.invalidResponse
                }
                appendUnique(page.items, to: &imports.unstartedFiles)
                loaded.imports = imports
                if let current = loaded.sectionPagination?.importFiles {
                    loaded.sectionPagination?.importFiles = update(current, count: imports.unstartedFiles.count, response: page.pagination)
                }
                workspace = loaded
            }
            return true
        } catch {
            guard connectionIsCurrent(client, version: connection), bootstrap?.identity.id == ownerID else { return false }
            workspacePageErrors[key] = "Couldn’t load more items. Check your connection and try again."
            return false
        }
    }

    @discardableResult
    func refreshCards(reportFailure: Bool = true) async -> Bool {
        guard let client else { return false }
        let version = connectionVersion
        let editRevision = edits.revision(for: [.cards])
        do {
            let result = try await client.cards()
            guard edits.revision(for: [.cards]) == editRevision, connectionIsCurrent(client, version: version) else { return false }
            savedCards = result.cards.map { card in
                var result = card
                if let marker = cardRefreshMarkers[card.id],
                   marker.holds(revisionId: card.revisionId, updatedAt: card.updatedAt, state: card.refreshState,
                                refreshTaskId: card.refreshTaskId) {
                    result.refreshState = "refreshing"
                    result.refreshError = nil
                }
                return result
            }
            return true
        } catch {
            guard connectionIsCurrent(client, version: version) else { return false }
            if reportFailure { reportError(error) }
            return false
        }
    }

    func refreshSavedCard(id: String, revisionId: String? = nil) async -> String? {
        guard let client else { return "Connect to your assistant to refresh this card." }
        let version = connectionVersion
        guard cardsBeingRefreshed.insert(id).inserted else { return "This card is already refreshing." }
        defer { if connectionVersion == version { cardsBeingRefreshed.remove(id) } }
        let data = messages.lazy.flatMap(\.parts).compactMap { part -> [String: JSONValue]? in
            guard part.type == "data-card", case let .object(data)? = part.data,
                  data["kind"] == .string("generated-card"), data["id"] == .string(id) else { return nil }
            return data
        }.first
        let saved = savedCards.first { $0.id == id }
        let expectedRevisionId = revisionId ?? data?["revisionId"]?.string ?? saved?.revisionId
        let operationKey = "\(id):\(expectedRevisionId ?? "legacy")"
        let operationId = cardRefreshOperations[operationKey] ?? UUID().uuidString.lowercased()
        cardRefreshOperations[operationKey] = operationId
        var marker = CardRefreshMarker(revisionId: expectedRevisionId,
            updatedAt: data?["updatedAt"]?.string ?? saved?.updatedAt)
        do {
            let result = try await client.refreshCard(
                id: id,
                expectedRevisionId: expectedRevisionId,
                operationId: operationId
            )
            guard connectionIdentityIsCurrent(client, version: version) else { return "Your connection changed. Check this card on its original assistant." }
            guard !Task.isCancelled else { return "The refresh could not be confirmed. Try again." }
            guard result.ok else { return "The refresh could not be started. Try again." }
            cardRefreshOperations.removeValue(forKey: operationKey)
            marker.taskId = result.taskId
            cardRefreshMarkers[id] = marker
            messages = messages.map { $0.applyingCardRefreshes([id: marker]) }
            edits.updateRemote(resources: [.cards]) { state in
                if let index = state.savedCards.firstIndex(where: { $0.id == id }) {
                    state.savedCards[index].refreshState = "refreshing"
                    state.savedCards[index].refreshError = nil
                }
            }
            await refreshDecisionMessages(refreshingCard: id)
            guard connectionIsCurrent(client, version: version) else { return nil }
            if !savedCards.isEmpty { await refreshCards(reportFailure: false) }
            return nil
        } catch {
            guard connectionIdentityIsCurrent(client, version: version) else { return "Your connection changed. Check this card on its original assistant." }
            if case let APIError.server(status: 409, _) = error {
                cardRefreshOperations.removeValue(forKey: operationKey)
                return "This card changed. Reload it before refreshing again."
            }
            return Task.isCancelled || isRequestCancellation(error) ? "The refresh could not be confirmed. Try again." : error.localizedDescription
        }
    }

    func loadSituationPacks() async throws -> SituationOverview {
        guard let client else { throw APIError.invalidServerURL }
        let version = connectionVersion
        let result = try await client.situationPacks()
        guard connectionIsCurrent(client, version: version) else { throw CancellationError() }
        cachedSituationPacks = result
        return result
    }

    func discussSituationPack(id: String) {
        packDiscussionDraft = "Review situation pack \(id). Read its latest state, respect recorded decisions, identify what I owe and what I am waiting on, and propose the next useful step. Do not perform external actions yet."
        present(.chat)
    }

    func consumePackDiscussionDraft() -> String? {
        defer { packDiscussionDraft = nil }
        return packDiscussionDraft
    }

    func changeSituationPack(_ command: SituationCommand) async throws -> SituationCommandResult {
        guard let client else { throw APIError.invalidServerURL }
        return try await client.changeSituationPack(command)
    }

    func dismissCard(_ card: SavedCardRecord) async -> Bool {
        return enqueueEdit("Dismiss card", resources: [.cards], patch: { state in
            state.savedCards.removeAll { $0.id == card.id }
        }) { try await $0.dismissCard(id: card.id) }
    }

    func uploadDocument(data: Data, name: String, title: String, mime: String) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.uploadDocument(data: data, name: name, title: title, mime: mime)
            reconcileAfterMutation()
            return true
        } catch {
            reportError(error)
            return false
        }
    }

    func deleteDocument(_ document: DocumentRecord) async -> Bool {
        return enqueueEdit("Remove document", resources: [.overview], patch: { state in
            state.overview?.documents.documents.removeAll { $0.id == document.id }
        }) { try await $0.deleteDocument(id: document.id) }
    }

    func uploadImport(
        data: Data,
        name: String,
        source: String = "",
        voice: Bool = false,
        register: String = ""
    ) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.uploadImport(
                data: data,
                name: name,
                source: source,
                voice: voice,
                register: register
            )
            Task { [weak self] in await self?.refreshWorkspace(reportFailure: false) }
            return true
        } catch {
            reportError(error)
            return false
        }
    }

    func updateImport(
        action: String,
        source: String,
        verdict: String? = nil,
        workspacePath: String? = nil
    ) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateImport(
                action: action,
                source: source,
                verdict: verdict,
                workspacePath: workspacePath
            )
            Task { [weak self] in await self?.refreshWorkspace(reportFailure: false) }
            return true
        } catch {
            reportError(error)
            return false
        }
    }

    func saveSkill(id: String? = nil, mutation: SkillMutation) async -> Bool {
        guard id?.hasPrefix("local:") != true else { return false }
        let localID = id ?? "local:" + UUID().uuidString
        let now = Date().ISO8601Format()
        return enqueueEdit("Skill changes", draft: [mutation.name, mutation.preconditions, mutation.steps, mutation.gotchas].joined(separator: "\n\n"), resources: [.workspace], retrySafe: id != nil, patch: { state in
            if let index = state.workspace?.skills.firstIndex(where: { $0.id == localID }) {
                state.workspace?.skills[index].name = mutation.name
                state.workspace?.skills[index].preconditions = mutation.preconditions
                state.workspace?.skills[index].steps = mutation.steps
                state.workspace?.skills[index].gotchas = mutation.gotchas
            } else {
                state.workspace?.skills.insert(WorkspaceSkill(id: localID, name: mutation.name,
                    preconditions: mutation.preconditions, steps: mutation.steps, gotchas: mutation.gotchas,
                    ownerAuthored: true, deprecated: false, useCount: 0, successCount: 0, failureCount: 0,
                    updatedAt: now), at: 0)
            }
        }) { client in
            if let id { try await client.updateSkill(id: id, skill: mutation) }
            else { try await client.createSkill(mutation) }
        }
    }

    func setSkillDeprecated(_ skill: WorkspaceSkill, deprecated: Bool) async -> Bool {
        guard !skill.id.hasPrefix("local:") else { return false }
        return enqueueEdit("Skill status", draft: skill.name + (deprecated ? " · Deprecated" : " · Available"), resources: [.workspace], patch: { state in
            guard let index = state.workspace?.skills.firstIndex(where: { $0.id == skill.id }) else { return }
            state.workspace?.skills[index].deprecated = deprecated
        }) { try await $0.setSkillDeprecated(id: skill.id, deprecated: deprecated) }
    }

    func deleteSkill(_ skill: WorkspaceSkill) async -> Bool {
        guard !skill.id.hasPrefix("local:") else { return false }
        return enqueueEdit("Remove skill", draft: [skill.name, skill.preconditions, skill.steps, skill.gotchas].joined(separator: "\n\n"), resources: [.workspace], patch: { state in
            state.workspace?.skills.removeAll { $0.id == skill.id }
        }) { try await $0.deleteSkill(id: skill.id) }
    }

    func updateCostLimits(_ limits: CostLimitsMutation) async -> Bool {
        return enqueueEdit("Spending limits", draft: "Per task: " + limits.taskDefault + "\nDaily: " + limits.daily + "\nMonthly: " + limits.monthly, resources: [.workspace], patch: { state in
            state.workspace?.costs.taskDefaultLimit = limits.taskDefault.isEmpty ? nil : limits.taskDefault
            state.workspace?.costs.dailyLimitUsd = Double(limits.daily)
            state.workspace?.costs.monthlyLimitUsd = Double(limits.monthly)
        }) { try await $0.updateCostLimits(limits) }
    }

    func updateAnomaly(_ anomaly: WorkspaceAnomaly, action: String) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateAnomaly(id: anomaly.id, action: action)
            Task { [weak self] in await self?.refreshWorkspace(reportFailure: false) }
            return true
        } catch {
            reportError(error)
            return false
        }
    }

    func reportRepair(title: String, summary: String, sourceTaskId: String? = nil) async -> Bool {
        guard let client else {
            errorMessage = "Connect to your assistant before reporting an issue."
            return false
        }
        let version = connectionVersion
        errorMessage = nil
        do {
            try await client.reportRepair(title: title, summary: summary, sourceTaskId: sourceTaskId)
            guard connectionIsCurrent(client, version: version) else { return false }
            Task { [weak self] in await self?.refreshWorkspace(reportFailure: false) }
            return connectionIsCurrent(client, version: version)
        } catch {
            guard connectionIsCurrent(client, version: version) else { return false }
            reportError(error)
            return false
        }
    }

    func updateRepair(_ issue: WorkspaceRepairIssue, action: String) async -> Bool {
        guard let client else { return false }
        let version = connectionVersion
        errorMessage = nil
        do {
            try await client.updateRepair(id: issue.id, action: action)
            guard connectionIsCurrent(client, version: version) else { return false }
            Task { [weak self] in await self?.refreshWorkspace(reportFailure: false) }
            return connectionIsCurrent(client, version: version)
        } catch {
            guard connectionIsCurrent(client, version: version) else { return false }
            reportError(error)
            return false
        }
    }

    func updateImprovement(_ improvement: WorkspaceImprovement, action: String) async -> ImprovementDecisionResult? {
        guard let client else { return nil }
        let version = connectionVersion
        errorMessage = nil
        do {
            let result = try await client.updateImprovement(id: improvement.id, action: action)
            guard connectionIsCurrent(client, version: version) else { return nil }
            Task { [weak self] in await self?.refreshWorkspace(reportFailure: false) }
            return connectionIsCurrent(client, version: version) ? result : nil
        } catch {
            guard connectionIsCurrent(client, version: version) else { return nil }
            guard !(error is CancellationError), !Task.isCancelled else { return nil }
            reportError(error)
            return ImprovementDecisionResult(ok: false, detail: errorMessage)
        }
    }

    func updateAgentSettings(_ mutation: AgentSettingsMutation) async -> Bool {
        return enqueueEdit("Assistant settings", draft: [mutation.timezone, mutation.locale, mutation.signature].joined(separator: "\n"), resources: [.workspace], patch: { state in
            state.workspace?.settings.agent.timezone = mutation.timezone
            state.workspace?.settings.agent.locale = mutation.locale
            state.workspace?.settings.agent.signature = mutation.signature
        }) { try await $0.updateSettings(mutation) }
    }

    func setSchedule(_ schedule: WorkspaceSchedule, enabled: Bool) async -> Bool {
        return enqueueEdit("Schedule changes", draft: schedule.displayName + (enabled ? " · On" : " · Off"), resources: [.workspace], patch: { state in
            guard let index = state.workspace?.settings.schedules.firstIndex(where: { $0.id == schedule.id }) else { return }
            state.workspace?.settings.schedules[index].enabled = enabled
        }) { try await $0.setScheduleEnabled(id: schedule.id, enabled: enabled) }
    }

    func deleteReminder(_ reminder: WorkspaceReminder) async -> Bool {
        return enqueueEdit("Remove reminder", draft: reminder.text, resources: [.workspace], patch: { state in
            state.workspace?.settings.reminders.removeAll { $0.id == reminder.id }
        }) { try await $0.deleteReminder(id: reminder.id) }
    }

    func setPolicy(_ policy: WorkspacePolicy, enabled: Bool) async -> Bool {
        return enqueueEdit("Standing approval changes", draft: policy.displayName + (enabled ? " · On" : " · Off"), resources: [.workspace], patch: { state in
            guard let index = state.workspace?.settings.policies.firstIndex(where: { $0.id == policy.id }) else { return }
            state.workspace?.settings.policies[index].enabled = enabled
        }) { try await $0.setPolicyEnabled(id: policy.id, enabled: enabled) }
    }

    func deletePolicy(_ policy: WorkspacePolicy) async -> Bool {
        return enqueueEdit("Remove standing approval", draft: policy.displayName, resources: [.workspace], patch: { state in
            state.workspace?.settings.policies.removeAll { $0.id == policy.id }
        }) { try await $0.deletePolicy(id: policy.id) }
    }

    @discardableResult
    func refreshMcpConnections(reportFailure: Bool = true) async -> Bool {
        guard let client else { return false }
        let version = connectionVersion
        do {
            let response = try await client.mcpConnections()
            guard connectionIsCurrent(client, version: version) else { return false }
            mcpConnections = response.connections
            mcpConnectionsLoaded = true
            return true
        } catch {
            guard connectionIsCurrent(client, version: version) else { return false }
            if reportFailure { reportError(error) }
            return false
        }
    }

    func createMcpConnection(name: String, endpoint: String, bearerToken: String?) async -> Bool {
        await mcpConnectionMutation {
            try await $0.createMcpConnection(name: name, endpoint: endpoint, bearerToken: bearerToken)
        }
    }

    func updateMcpConnection(id: String, action: String) async -> Bool {
        await mcpConnectionMutation { try await $0.updateMcpConnection(id: id, action: action) }
    }

    func deleteMcpConnection(id: String) async -> Bool {
        await mcpConnectionMutation { try await $0.deleteMcpConnection(id: id) }
    }

    private func mcpConnectionMutation(_ operation: (APIClient) async throws -> Void) async -> Bool {
        guard let client else { return false }
        let version = connectionVersion
        errorMessage = nil
        do {
            try await operation(client)
            guard connectionIsCurrent(client, version: version) else { return false }
            Task { [weak self] in await self?.refreshMcpConnections(reportFailure: false) }
            return connectionIsCurrent(client, version: version)
        } catch {
            guard connectionIsCurrent(client, version: version) else { return false }
            reportError(error)
            return false
        }
    }

    @discardableResult
    func refreshModelProviders(reportFailure: Bool = true) async -> Bool {
        guard let client else { return false }
        let version = connectionVersion
        let editRevision = edits.revision(for: [.providers])
        do {
            let response = try await client.modelProviders()
            guard edits.revision(for: [.providers]) == editRevision, connectionIsCurrent(client, version: version) else { return false }
            modelProviders = response
            return true
        } catch {
            guard connectionIsCurrent(client, version: version) else { return false }
            if reportFailure { reportError(error) }
            return false
        }
    }

    /// Saves the connection, then returns the models it offers (or why the test failed).
    func connectModelProvider(_ input: ModelConnectionInput) async -> ProviderConnectResult? {
        guard let client else { return nil }
        let version = connectionVersion
        errorMessage = nil
        do {
            let result = try await client.connectModelProvider(input)
            guard connectionIsCurrent(client, version: version) else { return nil }
            Task { [weak self] in await self?.refreshModelProviders() }
            guard connectionIsCurrent(client, version: version) else { return nil }
            return result
        } catch {
            guard connectionIsCurrent(client, version: version) else { return nil }
            reportError(error)
            return nil
        }
    }

    func testModelProvider(id: String) async -> [ProviderModelListing]? {
        guard let client else { return nil }
        let version = connectionVersion
        errorMessage = nil
        do {
            let result = try await client.testModelProvider(id: id)
            guard connectionIsCurrent(client, version: version) else { return nil }
            Task { [weak self] in await self?.refreshModelProviders() }
            guard connectionIsCurrent(client, version: version) else { return nil }
            return result.models
        } catch {
            guard connectionIsCurrent(client, version: version) else { return nil }
            guard connectionIsCurrent(client, version: version) else { return nil }
            Task { [weak self] in await self?.refreshModelProviders() }
            guard connectionIsCurrent(client, version: version) else { return nil }
            reportError(error)
            return nil
        }
    }

    func setModelProviderEnabled(id: String, enabled: Bool) async -> Bool {
        await modelProviderMutation { try await $0.setModelProviderEnabled(id: id, enabled: enabled) }
    }

    func removeModelProvider(id: String) async -> Bool {
        await modelProviderMutation { try await $0.removeModelProvider(id: id) }
    }

    func addProviderModel(
        connectionId: String,
        model: String,
        label: String?,
        inputPrice: String,
        outputPrice: String,
        thinking: Bool?
    ) async -> Bool {
        await modelProviderMutation {
            try await $0.addProviderModel(
                connectionId: connectionId,
                model: model,
                label: label,
                inputPrice: inputPrice,
                outputPrice: outputPrice,
                thinking: thinking
            )
        }
    }

    func chooseTextModels(main: String, fast: String) async -> Bool {
        return enqueueEdit("Default models", draft: "Main: " + main + "\nFast: " + fast, resources: [.providers], patch: { state in
            state.modelProviders?.mainModel = main
            state.modelProviders?.fastModel = fast
        }) { try await $0.chooseTextModels(main: main, fast: fast) }
    }

    func chooseVoiceModel(_ modelId: String) async -> Bool {
        return enqueueEdit("Voice model", draft: modelId, resources: [.providers], patch: { state in
            state.modelProviders?.voiceModel = modelId
        }) { try await $0.chooseVoiceModel(modelId) }
    }

    func addVoicePreset(connectionId: String, model: String) async -> Bool {
        await modelProviderMutation { try await $0.addVoicePreset(connectionId: connectionId, model: model) }
    }

    func loadPhoneCalls() async -> [PhoneCall]? {
        guard let client else { return nil }
        do {
            let version = connectionVersion
            let result = try await client.phoneCalls()
            guard connectionIsCurrent(client, version: version) else { return nil }
            cachedCalls = result.calls
            return result.calls
        } catch {
            reportError(error)
            return nil
        }
    }

    func loadPhoneCall(id: String) async -> PhoneCall? {
        guard let client else { return nil }
        return try? await client.phoneCall(id: id).call
    }

    func answerCallCheckin(callId: String, checkinId: String, revision: Int, answer: String) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.answerCallCheckin(callId: callId, checkinId: checkinId, revision: revision, answer: answer)
            return true
        } catch {
            reportError(error)
            return false
        }
    }

    func hangUpCall(callId: String) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.hangUpCall(callId: callId)
            return true
        } catch {
            reportError(error)
            return false
        }
    }

    private func modelProviderMutation(_ work: (APIClient) async throws -> Void) async -> Bool {
        guard let client else { return false }
        let version = connectionVersion
        errorMessage = nil
        do {
            try await work(client)
            guard connectionIsCurrent(client, version: version) else { return false }
            Task { [weak self] in await self?.refreshModelProviders() }
            return connectionIsCurrent(client, version: version)
        } catch {
            guard connectionIsCurrent(client, version: version) else { return false }
            reportError(error)
            return false
        }
    }

    func createMemory(_ memory: MemoryMutation) async -> Bool {
        let id = "local:" + UUID().uuidString
        let fact = WorkspaceMemoryFact(id: id, content: memory.content, kind: "fact", domain: memory.domain,
            ownerConfirmed: true, pinned: memory.pinned, importance: memory.importance, createdAt: Date().ISO8601Format())
        return enqueueEdit("New memory", draft: memory.content, resources: memoryEditResources, retrySafe: false, patch: { state in
            state.workspace?.memory.facts.removeAll { $0.id == id }
            state.workspace?.memory.facts.insert(fact, at: 0)
        }) { try await $0.createMemory(memory) }
    }

    func correctMemory(id: String, content: String) async -> Bool {
        guard !id.hasPrefix("local:") else { return false }
        return enqueueEdit("Memory correction", draft: content, resources: memoryEditResources, patch: { state in
            if let index = state.workspace?.memory.facts.firstIndex(where: { $0.id == id }) {
                state.workspace?.memory.facts[index].content = content
            }
            if let index = state.workspace?.memory.awaitingReview.firstIndex(where: { $0.id == id }) {
                state.workspace?.memory.awaitingReview[index].content = content
            }
            for query in state.memoryLibraries.keys {
                guard let index = state.memoryLibraries[query]?.rows.firstIndex(where: { $0.id == id }) else { continue }
                state.memoryLibraries[query]?.rows[index].content = content
            }
        }) { try await $0.updateMemory(id: id, content: content) }
    }

    func updateMemory(id: String, action: String, prominence: String? = nil, refreshAfterSave: Bool = true) async -> Bool {
        guard !id.hasPrefix("local:") else { return false }
        return enqueueEdit("Memory changes", draft: action + " " + (prominence ?? ""), resources: memoryEditResources, patch: { state in
            switch action {
            case "forget", "reject", "archive":
                state.workspace?.memory.facts.removeAll { $0.id == id }
                state.workspace?.memory.awaitingReview.removeAll { $0.id == id }
            case "confirm", "approve":
                if var fact = state.workspace?.memory.awaitingReview.first(where: { $0.id == id }) {
                    fact.ownerConfirmed = true
                    state.workspace?.memory.awaitingReview.removeAll { $0.id == id }
                    state.workspace?.memory.facts.removeAll { $0.id == id }
                    state.workspace?.memory.facts.insert(fact, at: 0)
                }
            default:
                if let index = state.workspace?.memory.facts.firstIndex(where: { $0.id == id }), prominence != nil {
                    state.workspace?.memory.facts[index].pinned = prominence == "always"
                    if prominence == "minor" { state.workspace?.memory.facts[index].importance = 1 }
                    else if prominence == "auto", (state.workspace?.memory.facts[index].importance ?? 3) <= 1 {
                        state.workspace?.memory.facts[index].importance = 3
                    }
                }
            }
            for query in state.memoryLibraries.keys {
                guard let index = state.memoryLibraries[query]?.rows.firstIndex(where: { $0.id == id }) else { continue }
                if ["forget", "reject", "archive", "approve"].contains(action) {
                    state.memoryLibraries[query]?.rows.removeAll { $0.id == id }
                } else if action == "confirm" {
                    state.memoryLibraries[query]?.rows[index].ownerConfirmed = true
                } else if action == "prominence" {
                    state.memoryLibraries[query]?.rows[index].pinned = prominence == "always"
                    if prominence == "minor" { state.memoryLibraries[query]?.rows[index].importance = 1 }
                    else if prominence == "auto", (state.memoryLibraries[query]?.rows[index].importance ?? 3) <= 1 {
                        state.memoryLibraries[query]?.rows[index].importance = 3
                    }
                }
            }
        }) { try await $0.updateMemory(id: id, action: action, prominence: prominence) }
    }

    func updateMemoryProfile(action: String) async -> Bool {
        guard let client else { return false }
        let version = connectionVersion
        let purgeID: UUID? = action.hasPrefix("purge") ? UUID() : nil
        if let purgeID {
            guard memoryErasureToken == nil else { return false }
            memoryErasureToken = purgeID
        }
        defer { if let purgeID, memoryErasureToken == purgeID { memoryErasureToken = nil } }
        if purgeID != nil {
            await edits.settle()
            guard connectionIsCurrent(client, version: version), !edits.hasUnknownWrite(in: [.memory]) else {
                errorMessage = "Review the memory save with an unknown outcome before clearing this data."
                return false
            }
        }
        errorMessage = nil
        do {
            try await client.updateMemoryProfile(action: action)
            guard connectionIsCurrent(client, version: version) else { return false }
            if action == "purge-voice" {
                edits.invalidateReads(for: [.voiceProfile, .workspace])
                edits.updateRemote(resources: [.voiceProfile]) { $0.voiceProfile = nil }
            }
            Task { [weak self] in await self?.refreshWorkspace(reportFailure: false) }
            return true
        } catch {
            reportError(error)
            return false
        }
    }

    func memoryLibrary(_ query: MemoryLibraryQuery, reportFailure: Bool = true, updateRecency: Bool = true) async -> MemoryLibraryResponse? {
        guard let client else { return nil }
        let version = connectionVersion
        let revision = edits.revision(for: [.memory, .library(query)])
        do {
            let response = try await client.memoryLibrary(query)
            guard connectionIsCurrent(client, version: version), edits.revision(for: [.memory, .library(query)]) == revision else { return nil }
            if updateRecency {
                memoryLibraryRecency.removeAll { $0 == query }
                memoryLibraryRecency.append(query)
                let evicted = Array(memoryLibraryRecency.dropLast(8))
                memoryLibraryRecency = Array(memoryLibraryRecency.suffix(8))
                edits.updateRemote(resources: [.library(query)], immediate: true) { state in
                    for key in evicted { state.memoryLibraries.removeValue(forKey: key) }
                    state.memoryLibraries[query] = response
                }
            } else {
                edits.updateRemote(resources: [.library(query)]) { state in
                    if state.memoryLibraries[query] != nil { state.memoryLibraries[query] = response }
                }
            }
            return response
        } catch {
            if reportFailure, !isRequestCancellation(error) { reportError(error) }
            return nil
        }
    }

    /// Open loops the assistant is tracking. Returns nil only on failure, so an
    /// empty list stays distinguishable from an unreachable server.
    func commitments() async -> [Commitment]? {
        if await reloadCommitments() { return cachedCommitments }
        return cachedCommitments
    }

    func updateCommitment(_ mutation: CommitmentMutation) async -> Bool {
        return enqueueEdit("Loop changes", draft: [mutation.title, mutation.details, mutation.nextAction].compactMap { $0 }.joined(separator: "\n"), resources: [.commitments], patch: { state in
            guard let index = state.commitments?.firstIndex(where: { $0.id == mutation.id }) else { return }
            if mutation.action == "correct" {
                if let title = mutation.title { state.commitments?[index].title = title }
                if let details = mutation.details { state.commitments?[index].details = details }
                if let next = mutation.nextAction { state.commitments?[index].nextAction = next }
            } else {
                state.commitments?.removeAll { $0.id == mutation.id }
            }
        }) { try await $0.updateCommitment(mutation) }
    }

    func voiceProfile() async -> VoiceProfileResponse? {
        _ = await reloadVoiceProfile()
        return cachedVoiceProfile
    }

    func saveVoiceProfile(_ profile: VoiceProfileMutation) async -> Bool {
        return enqueueEdit("Writing voice", draft: [profile.description, profile.dos, profile.donts, profile.signature].joined(separator: "\n\n"), resources: [.memory, .voiceProfile, .workspace], patch: { state in
            state.voiceProfile?.voiceProfile = VoiceProfile(description: profile.description,
                dos: profile.dos.components(separatedBy: .newlines).filter { !$0.isEmpty },
                donts: profile.donts.components(separatedBy: .newlines).filter { !$0.isEmpty }, signature: profile.signature)
        }) { try await $0.updateVoiceProfile(profile) }
    }

    func forgetLongTermMemory() async -> Bool {
        guard let client else { return false }
        let version = connectionVersion
        errorMessage = nil
        guard memoryErasureToken == nil else { return false }
        let erasureID = UUID()
        memoryErasureToken = erasureID
        defer { if memoryErasureToken == erasureID { memoryErasureToken = nil } }
        await edits.settle()
        guard connectionIsCurrent(client, version: version) else { return false }
        guard !edits.hasUnknownWrite(in: [.memory]) else {
            errorMessage = "A memory save still has an unknown outcome. Review the unsynced change and check its current information before erasing memory."
            return false
        }
        do {
            try await client.forgetLongTermMemory()
            guard connectionIsCurrent(client, version: version) else { return false }
            edits.invalidateReads(for: [.memory, .workspace, .voiceProfile, .commitments])
            edits.discardSettled(resources: [.memory])
            edits.updateRemote { state in
                state.workspace?.memory.facts = []
                state.workspace?.memory.awaitingReview = []
                state.memoryLibraries = [:]
                state.voiceProfile = nil
                state.commitments = nil
            }
            graphCache = [:]
            Task { [weak self] in await self?.refreshWorkspace(reportFailure: false) }
            return connectionIsCurrent(client, version: version)
        } catch {
            guard connectionIsCurrent(client, version: version) else { return false }
            reportError(error)
            return false
        }
    }

    /// Writes the export to a temporary file and hands back its URL, because
    /// the share sheet moves files rather than bytes. Named for the day it was
    /// taken so a folder of them stays readable.
    func exportMemoryFile() async -> URL? {
        guard let client else { return nil }
        let version = connectionVersion
        errorMessage = nil
        do {
            let data = try await client.memoryExport()
            guard connectionIsCurrent(client, version: version) else { return nil }
            let day = ISO8601DateFormatter.string(
                from: Date(),
                timeZone: .current,
                formatOptions: [.withFullDate]
            )
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("assistant-long-term-memory-\(day)-\(UUID().uuidString).json")
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            guard connectionIsCurrent(client, version: version) else { return nil }
            reportError(error)
            return nil
        }
    }

    func savePerson(id: String? = nil, mutation: PersonMutation) async -> Bool {
        guard id?.hasPrefix("local:") != true else { return false }
        let localID = id ?? "local:" + UUID().uuidString
        let aliases = mutation.aliases.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let initials = mutation.name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined()
        var resources: Set<MobileEditResource> = [.people, .personCaches, .workspace]
        if let id { resources.insert(.person(id)) }
        return enqueueEdit("Person changes", draft: [mutation.name, mutation.relationship, mutation.aliases].joined(separator: "\n"), resources: resources, retrySafe: id != nil, patch: { state in
            if let index = state.people.firstIndex(where: { $0.id == localID }) {
                state.people[index].name = mutation.name
                state.people[index].relationship = mutation.relationship
                state.people[index].initials = initials
            } else {
                state.people.insert(PersonSummary(id: localID, name: mutation.name, initials: initials,
                    relationship: mutation.relationship, group: "other", groupLabel: "", trust: "untrusted",
                    location: nil, factCount: 0, birthday: nil, birthdayDaysUntil: nil, lastContact: nil), at: 0)
            }
            state.personProfiles[localID]?.contact.name = mutation.name
            state.personProfiles[localID]?.contact.relationship = mutation.relationship
            state.personProfiles[localID]?.contact.aliases = aliases
            state.personCards[localID]?.name = mutation.name
            state.personCards[localID]?.relationship = mutation.relationship
            state.personCards[localID]?.initials = initials
            // Other dossiers can embed this person in relationships and merge options.
            state.personProfiles = state.personProfiles.filter { $0.key == localID }
            state.personCards = state.personCards.filter { $0.key == localID }
            if let index = state.workspace?.memory.people?.firstIndex(where: { $0.id == localID }) {
                state.workspace?.memory.people?[index].name = mutation.name
                state.workspace?.memory.people?[index].relationship = mutation.relationship
                state.workspace?.memory.people?[index].aliases = aliases
            }
        }) { client in
            if let id { try await client.updatePerson(id: id, person: mutation) }
            else { try await client.createPerson(mutation) }
        }
    }

    func deletePerson(id: String) async -> Bool {
        guard !id.hasPrefix("local:") else { return false }
        return enqueueEdit("Remove person", resources: [.people, .personCaches, .workspace], patch: { state in
            state.people.removeAll { $0.id == id }
            state.personProfiles = [:]
            state.personCards = [:]
            state.workspace?.memory.people?.removeAll { $0.id == id }
        }) { try await $0.deletePerson(id: id) }
    }

    func loadPeople() async {
        guard let client else { return }
        let version = connectionVersion
        let editRevision = edits.revision(for: [.people])
        let ownerID = bootstrap?.identity.id
        do {
            let response = try await client.people()
            guard edits.revision(for: [.people]) == editRevision, connectionIsCurrent(client, version: version), bootstrap?.identity.id == ownerID else { return }
            people = response.people
            peoplePagination = response.pagination.flatMap { $0.isSupported ? $0 : nil }
            peopleGeneration = response.generatedAt
            peoplePageError = response.pagination?.isSupported == true
                ? nil
                : "More people may be available, but this server did not provide a supported page cursor."
            peopleLoaded = true
        } catch where isRequestCancellation(error) {
            return
        } catch {
            guard connectionIsCurrent(client, version: version), bootstrap?.identity.id == ownerID else { return }
            reportError(error)
        }
    }

    @discardableResult
    func loadMorePeople() async -> Bool {
        guard let client, let pagination = peoplePagination, pagination.hasMore,
              let cursor = pagination.nextCursor, !peoplePageLoading else { return false }
        let version = connectionVersion
        let ownerID = bootstrap?.identity.id
        let generation = peopleGeneration
        peoplePageLoading = true
        peoplePageError = nil
        defer { peoplePageLoading = false }
        do {
            let response = try await client.peoplePage(cursor: cursor, limit: pagination.pageSize)
            guard connectionIsCurrent(client, version: version), bootstrap?.identity.id == ownerID,
                  peopleGeneration == generation, peoplePagination?.nextCursor == cursor else { return false }
            guard let next = response.pagination, next.isSupported, next.pageSize == pagination.pageSize,
                  next.nextCursor == nil || next.nextCursor != cursor,
                  response.people.count <= next.pageSize else {
                peoplePageError = "The people list returned an unsupported page. Refresh and try again."
                return false
            }
            edits.updateRemote(resources: [.people]) { state in
                var ids = Set(state.people.map(\.id))
                for person in response.people where ids.insert(person.id).inserted { state.people.append(person) }
            }
            peoplePagination = next
            return true
        } catch {
            guard connectionIsCurrent(client, version: version), bootstrap?.identity.id == ownerID,
                  peopleGeneration == generation else { return false }
            peoplePageError = "Couldn’t load more people. Check your connection and try again."
            return false
        }
    }

    @ObservationIgnored private var peopleGeneration: String?

    @discardableResult
    func loadMoreDocuments() async -> Bool {
        guard let client, let initial = edits.serverSnapshot.overview,
              let pagination = initial.documents.pagination, pagination.isSupported,
              pagination.hasMore, let cursor = pagination.nextCursor,
              !documentPageLoading else { return false }
        let version = connectionVersion
        let ownerID = bootstrap?.identity.id
        let generation = initial.generatedAt
        documentPageLoading = true
        documentPageError = nil
        defer { documentPageLoading = false }
        do {
            let page = try await client.documentsPage(cursor: cursor, limit: pagination.pageSize)
            guard connectionIsCurrent(client, version: version), bootstrap?.identity.id == ownerID,
                  let latest = edits.serverSnapshot.overview, latest.generatedAt == generation,
                  latest.documents.pagination?.nextCursor == cursor else { return false }
            guard let next = page.pagination, next.isSupported, next.pageSize == pagination.pageSize,
                  page.hasMore == next.hasMore,
                  next.nextCursor == nil || next.nextCursor != cursor,
                  page.documents.count <= next.pageSize else {
                documentPageError = "The document list returned an unsupported page. Refresh and try again."
                return false
            }
            var documents = latest.documents.documents
            var ids = Set(documents.map(\.id))
            for document in page.documents where ids.insert(document.id).inserted {
                documents.append(document)
            }
            overview = withLocalApprovalDecisions(.init(
                generatedAt: latest.generatedAt,
                activity: latest.activity,
                goals: latest.goals,
                approvals: latest.approvals,
                documents: DocumentsOverview(
                    documents: documents,
                    stats: page.stats,
                    primaryConversationId: page.primaryConversationId,
                    hasMore: next.hasMore,
                    pagination: next
                )
            ))
            return true
        } catch {
            guard connectionIsCurrent(client, version: version), bootstrap?.identity.id == ownerID,
                  overview?.generatedAt == generation else { return false }
            documentPageError = "Couldn’t load more documents. Check your connection and try again."
            return false
        }
    }

    func loadPersonCard(id: String) async {
        guard let client else { return }
        let version = connectionVersion
        let editRevision = edits.revision(for: [.person(id), .personCaches])
        do {
            let response = try await client.personCard(id: id)
            guard edits.revision(for: [.person(id), .personCaches]) == editRevision, connectionIsCurrent(client, version: version) else { return }
            edits.updateRemote(resources: [.person(id)]) { $0.personCards[id] = response }
        }
        catch where isRequestCancellation(error) { return }
        catch { if connectionIsCurrent(client, version: version) { reportError(error) } }
    }

    func loadPersonProfile(id: String) async {
        guard let client else { return }
        let version = connectionVersion
        let editRevision = edits.revision(for: [.person(id), .personCaches])
        do {
            let response = try await client.personProfile(id: id)
            guard edits.revision(for: [.person(id), .personCaches]) == editRevision, connectionIsCurrent(client, version: version) else { return }
            edits.updateRemote(resources: [.person(id)]) { $0.personProfiles[id] = response }
        }
        catch where isRequestCancellation(error) { return }
        catch { if connectionIsCurrent(client, version: version) { reportError(error) } }
    }

    func addOccasion(personId: String, mutation: OccasionMutation, occasionId: String? = nil) async -> Bool {
        guard !personId.hasPrefix("local:"), occasionId?.hasPrefix("local:") != true else { return false }
        let id = occasionId ?? "local:" + UUID().uuidString
        return enqueueEdit("Occasion changes", draft: [mutation.kind, mutation.label, mutation.month + "/" + mutation.day + "/" + mutation.year, mutation.leadDays + " days before", mutation.notes].joined(separator: "\n"), resources: [.people, .person(personId)], retrySafe: occasionId != nil, patch: { state in
            state.personProfiles[personId]?.occasions.removeAll { $0.id == id }
            state.personProfiles[personId]?.occasions.append(PersonOccasion(id: id, kind: mutation.kind,
                label: mutation.label, month: Int(mutation.month) ?? 1, day: Int(mutation.day) ?? 1,
                year: Int(mutation.year), notes: mutation.notes, quarantined: false, leadDays: Int(mutation.leadDays)))
        }) { client in
            if let occasionId { try await client.updateOccasion(id: occasionId, occasion: mutation) }
            else { try await client.addOccasion(personId: personId, occasion: mutation) }
        }
    }

    func reviewOccasion(personId: String, occasion: PersonOccasion, verdict: String) async -> Bool {
        guard let client else { return false }
        do {
            try await client.reviewOccasion(id: occasion.id, verdict: verdict)
            await loadPersonProfile(id: personId)
            await loadPersonCard(id: personId)
            await loadPeople()
            return true
        } catch {
            reportError(error)
            return false
        }
    }

    func deleteOccasion(personId: String, occasion: PersonOccasion) async -> Bool {
        guard !occasion.id.hasPrefix("local:") else { return false }
        return enqueueEdit("Remove occasion", draft: occasion.label + " " + String(occasion.month) + "/" + String(occasion.day), resources: [.people, .person(personId)], patch: { state in
            state.personProfiles[personId]?.occasions.removeAll { $0.id == occasion.id }
        }) { try await $0.deleteOccasion(id: occasion.id) }
    }

    /// Drop the cached person cards and profiles.
    ///
    /// Editing the graph changes what a person's page says about them, but the
    /// graph screen only ever updated its own canvas — so returning to a
    /// profile showed a relationship list that predated the edit until the
    /// owner happened to pull to refresh. Clearing the cache makes the next
    /// view of any person reload.
    func invalidatePersonCaches() {
        personCards.removeAll()
        personProfiles.removeAll()
        // The directory is a cache too: a deleted, merged or re-related person
        // changes who is listed and how. Leaving peopleLoaded true meant People
        // kept showing the old list until the owner happened to pull to refresh.
        peopleLoaded = false
    }

    func mergePerson(id: String, targetId: String) async -> Bool {
        guard let client else { return false }
        do {
            try await client.mergePerson(id: id, targetId: targetId)
            // Both sides change: the merged-away person disappears and the
            // target gains their facts, so neither cached card is still true.
            invalidatePersonCaches()
            await loadPeople()
            Task { [weak self] in await self?.refreshWorkspace(reportFailure: false) }
            return true
        } catch {
            reportError(error)
            return false
        }
    }

    /// `spoken` says this turn will be heard rather than read, and asks the
    /// server for a reply shaped for the ear: short, no tables, no Markdown to
    /// pronounce.
    func send(_ rawText: String, autonomous override: Bool? = nil, force: Bool = false,
              spoken: Bool = false, calendarContextReady: Bool = false,
              composerDraftContext: ComposerDraftSubmissionContext? = nil,
              onComposerDraftStage: (@MainActor (ComposerDraftSubmissionProvenance) -> Void)? = nil,
              onComposerDraftClear: (@MainActor (ComposerDraftSnapshot, ComposerDraftSnapshot) -> Void)? = nil) {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending,
              let client,
              let conversationId, let draftScope = composerDraftScope else { return }
        guard cardFormRecoveryReady, cardFormUnknownOperationIds.isEmpty,
              cardFormUnknownOperationId == nil else {
            errorMessage = "Check the saved form request before sending another message."
            return
        }
        if cardFormActiveOwnerMessageTexts.values.contains(where: {
            text == $0.trimmingCharacters(in: .whitespacesAndNewlines)
        }) {
            errorMessage = "That form message is still unsent while the active request is running. You can send a different reply."
            return
        }
        guard resumableTurn == nil, ordinaryTurn == nil else {
            errorMessage = "The previous turn’s status is still unknown. Reconnect to check it before starting another turn."
            return
        }
        if !calendarContextReady,
           (phoneCalendarSharing.isSharingEnabled || phoneCalendarSharing.hasPendingMutation
            || phoneCalendarSharing.hasPendingRemoval || phoneCalendarSharing.requiresPermissionReview),
           let ownerID = bootstrap?.identity.id {
            guard !isPreparingCalendarContext else { return }
            isPreparingCalendarContext = true
            calendarPreflightRevision += 1
            let preflightRevision = calendarPreflightRevision
            // Prepared actions can coexist with another draft. Only stage an
            // initiating empty composer, or retain the model-only caller's
            // existing staging behavior. Capture the result before the await.
            let submissionSnapshot: ComposerDraftSnapshot?
            if let context = composerDraftContext {
                submissionSnapshot = context.mayStageSubmittedText && context.origin.scope == draftScope
                    ? saveComposerDraft(text, in: draftScope, ifUnchangedFrom: context.origin)
                    : nil
            } else {
                submissionSnapshot = saveComposerDraft(text, in: draftScope)
            }
            if let context = composerDraftContext, let submissionSnapshot {
                onComposerDraftStage?(.init(origin: context.origin, staged: submissionSnapshot))
            }
            errorMessage = "Checking the shared calendar snapshot before sending…"
            let version = connectionVersion
            Task { [weak self] in
                guard let self else { return }
                let ready = await self.phoneCalendarSharing.synchronizeBeforeChat(
                    client: client, expectedOwnerID: ownerID, timeout: .seconds(5)
                )
                guard self.calendarPreflightRevision == preflightRevision else { return }
                guard self.connectionIdentityIsCurrent(client, version: version),
                      self.bootstrap?.identity.id == ownerID else {
                    self.isPreparingCalendarContext = false
                    return
                }
                self.isPreparingCalendarContext = false
                guard self.composerDraftScope == draftScope else { return }
                if !ready && !self.phoneCalendarSharing.matchesBinding(client: client, expectedOwnerID: ownerID) {
                    self.errorMessage = "The assistant account or server changed while calendar sharing was being checked. Review the connection before sending this message."
                    self.calendarDraftRestoreRevision += 1
                    return
                }
                if let submissionSnapshot,
                   let cleared = self.saveComposerDraft("", in: draftScope, ifUnchangedFrom: submissionSnapshot) {
                    if let context = composerDraftContext {
                        onComposerDraftClear?(context.origin, cleared)
                    }
                }
                if ready {
                    self.errorMessage = nil
                    self.send(text, autonomous: override, force: force, spoken: spoken, calendarContextReady: true)
                } else {
                    self.send(text, autonomous: override, force: force, spoken: spoken, calendarContextReady: true)
                    self.errorMessage = self.phoneCalendarSharing.hasPendingRemoval
                        ? "Calendar removal is still pending; the server may still have the last uploaded snapshot."
                        : self.phoneCalendarSharing.requiresPermissionReview
                            ? "Calendar uploads are paused for review; answers may use the last uploaded snapshot."
                        : self.phoneCalendarSharing.isSharingEnabled || self.phoneCalendarSharing.hasPendingMutation
                            ? "Calendar sync did not finish; answers may use the last uploaded snapshot."
                            : "Calendar sharing is off; this answer may not include iPhone calendar details."
                }
            }
            return
        }
        let version = connectionVersion
        conversationIntentGeneration += 1

        let autonomous = override ?? nextMessageAutonomous
        let clientOperationId = UUID().uuidString.lowercased()
        let requestBody: Data
        do {
            requestBody = try client.encodeChatRequest(
                conversationId: conversationId, text: text, clientOperationId: clientOperationId,
                autonomous: autonomous, force: force, spoken: spoken, clientMessageId: UUID().uuidString
            )
        } catch {
            reportError(error)
            return
        }
        nextMessageAutonomous = false
        errorMessage = nil
        isSending = true
        isCancellingSend = false
        cancelRequestedWithoutTaskID = false
        lastNotifiedTaskState = nil
        let localUser = ChatMessage.optimistic(role: .user, text: text)
        let streamID = "stream-\(UUID().uuidString)"
        let turnToken = UUID()
        messages.append(localUser)
        messages.append(.optimistic(role: .assistant, text: "", id: streamID))
        // Neither row has a send time yet, so both anchor to the end of the
        // durable log and hold that place until their persisted twins arrive.
        messages = logOrder.ordered(messages)
        setActivityThought(.thinking, proposedDetail: text)
        thoughtClearTask?.cancel()

        pollTask?.cancel()
        beginSpeaking(streamID: streamID)
        // Recorded before the send, not after the receipt: backgrounding during
        // the stream is exactly the case this exists for, and at that point
        // there is no taskId yet. Polling by cursor alone still finds the reply.
        resumableTurn = (taskId: nil, streamID: streamID)
        ordinaryTurn = OrdinaryTurn(
            token: turnToken,
            operationId: clientOperationId,
            conversationId: conversationId,
            streamID: streamID,
            userMessageID: localUser.id,
            ownerText: text,
            requestBody: requestBody,
            taskId: nil,
            cancellationRequested: false
        )
        pollTask = Task { [weak self] in
            guard let self else { return }
            // `ensure`, not `start`: starting ends every live activity first,
            // so a message sent while background work was already on the island
            // collapsed it and replayed the whole attach animation.
            await LiveActivityManager.shared.ensure(
                agentName: agentName,
                thought: .thinking,
                detail: text
            )
            guard self.isCurrentOrdinaryTurn(turnToken, client: client, version: version, conversationId: conversationId) else { return }
            do {
                let receipt = try await client.sendMessage(
                    conversationId: conversationId,
                    text: text,
                    clientOperationId: clientOperationId,
                    autonomous: autonomous,
                    force: force,
                    spoken: spoken,
                    encodedRequestBody: requestBody,
                    onDelta: { [weak self] delta in
                        await self?.receive(delta: delta, streamID: streamID, client: client,
                            version: version, conversationId: conversationId, turnToken: turnToken)
                    },
                    onCue: { [weak self] part in
                        await self?.receive(cue: part, streamID: streamID, client: client,
                            version: version, conversationId: conversationId, turnToken: turnToken)
                    }
                )
                guard self.isCurrentOrdinaryTurn(turnToken, client: client, version: version, conversationId: conversationId) else { return }
                if receipt.taskId != nil {
                    self.messages.removeAll { $0.id == streamID }
                    await self.publishThought(.startingWork, detail: text)
                }
                guard self.isCurrentOrdinaryTurn(turnToken, client: client, version: version, conversationId: conversationId) else { return }
                if let receiptCursor = receipt.cursor { self.cursor = receiptCursor }
                self.resumableTurn = (taskId: receipt.taskId, streamID: streamID)
                self.ordinaryTurn?.taskId = receipt.taskId
                if self.isCancellingSend, let taskId = receipt.taskId {
                    await self.requestCancellation(
                        taskId: taskId, client: client, version: version,
                        conversationId: conversationId, turnToken: turnToken
                    )
                }
                await self.pollForReply(taskId: receipt.taskId, streamID: streamID, ordinaryTurnToken: turnToken)
            } catch where isRequestCancellation(error) {
                guard self.isCurrentOrdinaryTurn(turnToken, client: client, version: version, conversationId: conversationId) else { return }
                // A cancelled socket is not evidence the send failed. Recover
                // via the saved cursor; never replay the message POST.
                await self.pollForReply(taskId: self.resumableTurn?.taskId, streamID: streamID, ordinaryTurnToken: turnToken)
            } catch APIError.chatTurnCancelledBeforeAdmission(let cancelledConversation, let cancelledOperation) {
                guard self.isCurrentOrdinaryTurn(turnToken, client: client, version: version, conversationId: conversationId),
                      cancelledConversation == conversationId,
                      cancelledOperation == clientOperationId else { return }
                self.settleCancelledBeforeAdmission(turnToken: turnToken, text: text, draftScope: draftScope)
            } catch {
                // URLSession's byte stream reports a cancelled task as
                // URLError.cancelled rather than CancellationError, so a turn
                // stopped from the composer would otherwise surface as an error
                // banner. cancelSend owns the UI state in that case.
                guard self.isCurrentOrdinaryTurn(turnToken, client: client, version: version, conversationId: conversationId) else { return }
                if self.isCancellingSend {
                    self.setActivityThought(.thinking, proposedDetail: "The stop outcome is unknown. Checking the conversation.")
                    await self.pollForReply(taskId: self.resumableTurn?.taskId, streamID: streamID, ordinaryTurnToken: turnToken)
                    return
                }
                if Self.isAmbiguousChatAdmissionError(error) {
                    self.isSending = false
                    self.errorMessage = "This turn’s outcome is unknown. Check the same turn before sending another message."
                    self.setActivityThought(.thinking, proposedDetail: "Turn status unknown. Check this same operation.")
                    return
                }
                self.messages.removeAll { $0.id == streamID && $0.text.isEmpty }
                // The composer cleared the draft when it sent; a failed turn
                // gives the words back rather than losing them to the failure.
                self.restorableDraft = text
                self.conversationDrafts.preserveUnsent(text, in: draftScope)
                self.composerRecoveryRevision += 1
                self.reportError(error)
                let settlement = self.notificationTurnSettlements.begin()
                defer { self.notificationTurnSettlements.finish(settlement) }
                self.isSending = false
                self.isCancellingSend = false
                self.resumableTurn = nil
                self.setActivityThought(.stopped, proposedDetail: error.localizedDescription)
                await LiveActivityManager.shared.finish(
                    thought: .stopped,
                    detail: error.localizedDescription,
                    succeeded: false
                )
                guard self.isCurrentOrdinaryTurn(turnToken, client: client, version: version, conversationId: conversationId) else { return }
                self.clearThought(after: 4)
                self.notificationTurnSettlements.finish(settlement)
                await self.resolvePendingNotificationDestination()
                guard self.ordinaryTurn?.token == turnToken else { return }
                self.ordinaryTurn = nil
            }
        }
    }

    func decide(_ item: PendingApproval, decision: String) async -> Bool {
        await decideApproval(id: item.id, decision: decision)
    }

    /// Take a decided approval out of the local inbox on the tap, ahead of the
    /// server's answer. Returns the item and where it sat so a failure can put
    /// it back exactly there.
    private func optimisticallyResolveApproval(id: String) -> (item: PendingApproval, index: Int)? {
        guard let current = edits.serverSnapshot.overview,
              let index = current.approvals.pending.firstIndex(where: { $0.id == id }) else { return nil }
        let item = current.approvals.pending[index]
        edits.updateRemote(resources: [.overview], immediate: true) { state in
            guard let snapshot = state.overview else { return }
            state.overview = overviewReplacingPending(snapshot.approvals.pending.filter { $0.id != id }, in: snapshot)
        }
        return (item, index)
    }

    private func overviewReplacingPending(_ pending: [PendingApproval], in current: OverviewResponse) -> OverviewResponse {
        OverviewResponse(
            generatedAt: current.generatedAt,
            activity: current.activity,
            goals: current.goals,
            approvals: ApprovalInbox(pending: pending, resolved: current.approvals.resolved),
            documents: current.documents
        )
    }

    /// Lay what was decided on this device over a read that may predate it.
    /// An overview request that left before the tap comes back still listing
    /// the approval; applied as-is it resurrects the card, and
    /// `reconcileBaselineActivity` then raises the Island for a decision the
    /// owner already made.
    private func withLocalApprovalDecisions(_ response: OverviewResponse) -> OverviewResponse {
        guard !approvalsBeingDecided.isEmpty || !acceptedApprovalDecisions.isEmpty,
              response.approvals.pending.contains(where: {
                  approvalsBeingDecided.contains($0.id) || acceptedApprovalDecisions[$0.id] != nil
              }) else { return response }
        return overviewReplacingPending(
            response.approvals.pending.filter {
                !approvalsBeingDecided.contains($0.id) && acceptedApprovalDecisions[$0.id] == nil
            },
            in: response
        )
    }

    private func restorePendingApproval(_ removed: (item: PendingApproval, index: Int)) {
        guard let current = edits.serverSnapshot.overview,
              !current.approvals.pending.contains(where: { $0.id == removed.item.id }) else { return }
        edits.updateRemote(resources: [.overview], immediate: true) { state in
            guard let snapshot = state.overview else { return }
            var pending = snapshot.approvals.pending
            if !pending.contains(where: { $0.id == removed.item.id }) {
                pending.insert(removed.item, at: min(removed.index, pending.count))
            }
            state.overview = overviewReplacingPending(pending, in: snapshot)
        }
    }

    private func setDecisionStatus(id: String, status: String) {
        acceptedApprovalDecisions[id] = status
        // One pass, one write. This used to mutate `messages[i].parts[j]` in
        // place for every part of every message, and each of those writes
        // told every observer of the model that something changed — hundreds
        // of invalidations of the transcript for a single tap.
        var updated = messages
        var changed = false
        for index in updated.indices {
            let next = updated[index].applyingApprovalDecisions([id: status])
            if next != updated[index] {
                updated[index] = next
                changed = true
            }
        }
        if changed { messages = updated }
    }

    private func performApprovalMutation(
        id: String,
        status: String,
        refreshingWorkspace: Bool = false,
        operation: () async throws -> ApprovalResult
    ) async -> Bool {
        guard let client else { return false }
        let version = connectionVersion
        errorMessage = nil
        approvalsBeingDecided.insert(id)
        let removed = optimisticallyResolveApproval(id: id)
        // The card leaves the app on this frame, so the Island and the badge
        // leave with it — but the request does not wait for them. Ending an
        // activity is a round-trip to the system, and it used to sit in front
        // of the POST, which made every tap feel as slow as the Island is.
        // The manager serialises its own work, so firing it here is safe.
        Task { [weak self] in
            guard let self, self.connectionIsCurrent(client, version: version) else { return }
            await self.syncApprovalSurfaces()
        }
        do {
            let result = try await operation()
            guard connectionIsCurrent(client, version: version) else { return false }
            guard result.ok else { throw APIError.server(status: 409, message: "The approval decision was not accepted.") }
            setDecisionStatus(id: id, status: status)
            approvalsBeingDecided.remove(id)
            // The server has accepted the decision, so the control is done.
            // The inbox and the chat's decision cards converge from here in
            // the background; they used to be awaited, which held every
            // button on the screen disabled for two more round-trips.
            scheduleApprovalReconciliation(refreshingWorkspace: refreshingWorkspace)
            return true
        } catch {
            guard connectionIsCurrent(client, version: version) else { return false }
            approvalsBeingDecided.remove(id)
            if let removed { restorePendingApproval(removed) }
            Task { [weak self] in
                guard let self, self.connectionIsCurrent(client, version: version) else { return }
                await self.syncApprovalSurfaces()
            }
            reportError(error)
            return false
        }
    }

    private func scheduleApprovalReconciliation(refreshingWorkspace: Bool = false) {
        // Chained, not replaced: two quick decisions each get their re-read, and
        // a standing approval's Settings refresh is never cancelled by the next tap.
        let previous = approvalReconciliation
        guard let client else { return }
        let version = connectionVersion
        approvalReconciliation = Task { [weak self] in
            await previous?.value
            guard let self, self.connectionIsCurrent(client, version: version) else { return }
            async let inbox: Bool = self.refreshOverview(reportFailure: false)
            async let decisions: Void = self.refreshDecisionMessages()
            // A standing approval adds a rule to Settings. That is the heaviest
            // read the app makes and nothing on the approval screen waits on it.
            async let workspace: Bool = refreshingWorkspace
                ? self.refreshWorkspace(reportFailure: false)
                : false
            _ = await (inbox, decisions, workspace)
        }
    }

    /// Wait for the re-read a decision started. Tests use this; the app never
    /// needs to, which is the point.
    func settleApprovalReconciliation() async {
        await approvalReconciliation?.value
    }

    /// Point the system approval surfaces at the local inbox as it stands now.
    ///
    /// Deliberately not `reconcileBaselineActivity`: that one is a full
    /// baseline pass and bails out while a turn is in flight, so an approval
    /// answered from a chat decision card — the common case, since the turn is
    /// still polling while it waits — would have left the Island up until the
    /// poll loop next looked. The only system Live Activity is a live
    /// approval, so an empty inbox means there is nothing for it to show,
    /// whether or not a turn is running.
    private func syncApprovalSurfaces() async {
        if let next = overview?.approvals.pending.first {
            await LiveActivityManager.shared.needsAttention(
                agentName: agentName,
                detail: next.approval.summary,
                pendingCount: pendingApprovalCount
            )
        } else {
            await LiveActivityManager.shared.dismiss()
        }
        await syncNotificationBadge()
    }

    /// Inline approve/decline from a chat decision card, keyed by the message
    /// part's approvalId rather than a fetched PendingApproval row.
    func decideApproval(id: String, decision: String) async -> Bool {
        guard let client else { return false }
        return await performApprovalMutation(id: id, status: decision) {
            try await client.decideApproval(id: id, decision: decision)
        }
    }

    /// Read the current owner inbox, not properties captured by an older View.
    /// A removed row retires local review publication; an accepted durable receipt
    /// remains authoritative and continues through ordinary reconciliation.
    func ownerCallReviewSourceIsCurrent(_ origin: OwnerCallReviewSourceIdentity) -> Bool {
        guard activityConnectionRevision == origin.connectionRevision, client != nil,
              let pending = overview?.approvals.pending.first(where: { $0.id == origin.approvalID }) else { return false }
        return pending.taskTrust == "owner" && pending.toolName == "phone.call"
            && pending.approval.status == "pending" && pending.ownerNumberGrantAvailable == true
            && pending.ownerCallSourceFingerprint == origin.sourceFingerprint
            && pending.approval.payload == origin.source
    }

#if DEBUG
    /// Pure native fixture projection: no notifications, badges, Live Activities or reads.
    func installOwnerCallReviewProjectionForTesting(_ projection: OverviewResponse, connectionRevision: Int) {
        overview = projection
        activityConnectionRevision = connectionRevision
    }
#endif

    func previewOwnerCallNumberGrant(id: String, validityChoice: String) async throws -> OwnerCallNumberGrantPreview {
        guard let client else { throw APIError.invalidServerURL }
        let version = connectionVersion
        let review = try await client.previewOwnerCallNumberGrant(id: id, validityChoice: validityChoice)
        guard connectionIsCurrent(client, version: version) else { throw APIError.invalidResponse }
        return review
    }

    /// Keep permission off locally until the atomic approval-and-grant response arrives.
    func approveOwnerCallNumberGrant(id: String, reviewToken: String) async -> String? {
        guard let client else { return "Connect to your assistant to review again." }
        let version = connectionVersion
        guard approvalsBeingDecided.insert(id).inserted else { return "This decision is still being saved." }
        defer { if connectionVersion == version { approvalsBeingDecided.remove(id) } }
        do {
            let receipt = try await client.approveOwnerCallNumberGrant(id: id, reviewToken: reviewToken)
            guard connectionIsCurrent(client, version: version), receipt.ok, receipt.ownerCallNumberGrant != nil else { throw APIError.invalidResponse }
            setDecisionStatus(id: id, status: "approved")
            scheduleApprovalReconciliation(refreshingWorkspace: true)
            return nil
        } catch {
            if case APIError.server(status: 409, message: "This review expired or changed. Review again.") = error {
                return "This review expired or changed. Review again."
            }
            if connectionIsCurrent(client, version: version) { _ = await refreshOverview(reportFailure: false) }
            return "Could not confirm result. Refresh to check this call and saved permission before trying again."
        }
    }

    func approveAndRemember(_ item: PendingApproval) async -> Bool {
        await approveAndRemember(id: item.id)
    }

    func approveAndRemember(id: String) async -> Bool {
        guard let client else { return false }
        return await performApprovalMutation(id: id, status: "approved", refreshingWorkspace: true) {
            try await client.approveAndRemember(id: id)
        }
    }

    func editAndApprove(_ item: PendingApproval, payload: JSONValue) async -> Bool {
        guard let client else { return false }
        return await performApprovalMutation(id: item.id, status: "approved") {
            try await client.editAndApprove(id: item.id, payload: payload)
        }
    }

    /// Answer a proactive suggestion from its chat card. Kept apart from the
    /// approval path on purpose: nothing waits on a suggestion, so the inbox,
    /// the badge and the Island are never touched.
    ///
    /// The card shows progress until the server acknowledges the answer.
    /// Returns what the card should say if the request fails —
    /// inline, where the owner tapped, rather than as a banner — and nil when
    /// there is nothing to say.
    func decideSuggestion(id: String, decision: SuggestionDecision) async -> String? {
        guard let client else { return "Connect to your assistant to answer this." }
        let version = connectionVersion
        guard suggestionsBeingAnswered.insert(id).inserted else { return "Your answer is still being saved." }
        defer { if connectionVersion == version { suggestionsBeingAnswered.remove(id) } }
        do {
            let result = try await client.decideSuggestion(id: id, decision: decision)
            guard connectionIdentityIsCurrent(client, version: version) else { return "Your connection changed. Check this suggestion on its original assistant." }
            guard !Task.isCancelled else { return "Your answer could not be confirmed. Try again." }
            guard result.ok else {
                throw APIError.server(status: 409, message: "This suggestion could not be updated.")
            }
            let snoozedUntil = decision == .snoozed
                ? result.snoozedUntil.flatMap {
                    ISO8601DateFormatter.assistant.date(from: $0)
                        ?? AssistantFormatters.internetDateTime.date(from: $0)
                }
                : nil
            setSuggestionAnswer(.init(decision: decision, taskId: result.taskId, snoozedUntil: snoozedUntil), for: id)
            // Accepting creates work. Activity should already have it by the
            // time the owner goes looking.
            if decision == .accepted { await refreshOverview(reportFailure: false) }
            guard connectionIsCurrent(client, version: version) else { return nil }
            await refreshDecisionMessages(answeringSuggestion: id)
            return nil
        } catch {
            guard connectionIdentityIsCurrent(client, version: version) else { return "Your connection changed. Check this suggestion on its original assistant." }
            return Task.isCancelled || isRequestCancellation(error)
                ? "Your answer could not be confirmed. Try again."
                : error.localizedDescription
        }
    }

    private func setSuggestionAnswer(_ answer: SuggestionAnswer, for id: String) {
        suggestionAnswers[id] = answer
        messages = messages.map { $0.applyingSuggestionAnswers([id: answer], acknowledging: true) }
    }

    /// Every read of the log passes through here, so an answer given on this
    /// device outlives a poll that left before it did.
    private func withLocalDecisions(_ message: ChatMessage) -> ChatMessage {
        message
            .applyingApprovalDecisions(acceptedApprovalDecisions)
            .applyingSuggestionAnswers(suggestionAnswers)
            .applyingCardRefreshes(cardRefreshMarkers)
    }

    /// Legacy summaries may have only a task ID. Ask the server to hydrate
    /// their outcomes after a decision, not just the independent inbox. Do
    /// not replace the whole transcript or advance a concurrent poll's cursor.
    /// A suggestion just answered joins them by id: a day of briefings holds
    /// plenty of settled ones that must not crowd approvals out of the ten.
    private func refreshDecisionMessages(answeringSuggestion suggestionId: String? = nil, refreshingCard cardId: String? = nil) async {
        guard let client, let conversationId else { return }
        let version = connectionVersion
        let targets = messages.reversed().filter { message in
            (suggestionId != nil && message.suggestionParts.contains { $0.suggestionId == suggestionId })
                || (cardId != nil && message.parts.contains { part in
                    guard case let .object(data)? = part.data else { return false }
                    return data["kind"] == .string("generated-card") && data["id"]?.string == cardId
                })
        }
        let decisions = messages.reversed().filter { !$0.decisionParts.isEmpty || $0.approvalSummary != nil }
        var seen = Set<String>()
        let ids = (targets + decisions).map(\.id).filter { seen.insert($0).inserted }.prefix(10)
        guard !ids.isEmpty else { return }
        guard let updates = try? await client.updates(conversationId: conversationId, taskId: nil,
            cursor: cursor, refreshIds: Array(ids)), connectionIsCurrent(client, version: version),
            self.conversationId == conversationId else { return }
        merge(updates.refreshed)
    }

    private static func isAmbiguousChatAdmissionError(_ error: Error) -> Bool {
        guard let apiError = error as? APIError else { return true }
        switch apiError {
        case .transport, .invalidResponse, .decoding:
            return true
        case let .server(status, _):
            return status == 409 || status >= 500
        case .invalidServerURL, .chatTurnCancelledBeforeAdmission, .unauthorized:
            return false
        }
    }

    private func isCurrentOrdinaryTurn(
        _ token: UUID,
        client: APIClient,
        version: Int,
        conversationId: String
    ) -> Bool {
        connectionIsCurrent(client, version: version)
            && self.conversationId == conversationId
            && ordinaryTurn?.token == token
            && ordinaryTurn?.conversationId == conversationId
    }

    private func settleCancelledBeforeAdmission(turnToken: UUID, text: String, draftScope: ComposerDraftScope) {
        guard ordinaryTurn?.token == turnToken else { return }
        let streamID = ordinaryTurn?.streamID
        let userMessageID = ordinaryTurn?.userMessageID
        messages.removeAll { $0.id == streamID || $0.id == userMessageID }
        spokenTurn = nil
        restorableDraft = text
        conversationDrafts.preserveUnsent(text, in: draftScope)
        composerRecoveryRevision += 1
        ordinaryTurn = nil
        resumableTurn = nil
        isSending = false
        isCancellingSend = false
        cancelRequestedWithoutTaskID = false
        errorMessage = "This message was cancelled before it entered the queue."
        setActivityThought(.stopped, proposedDetail: "Cancelled before admission")
    }

    /// Requests cancellation of the server task when its identity is known.
    /// Until the matching task status arrives, the outcome remains unresolved.
    func cancelSend() {
        guard (isSending || ordinaryTurn != nil),
              !isCancellingSend, !isCardFormAdmissionPending else { return }
        isCancellingSend = true
        stopSpeaking()
        let detail = "Stop requested. Checking the server status."
        setActivityThought(.thinking, proposedDetail: detail)
        Task { await LiveActivityManager.shared.ensure(agentName: agentName, thought: .thinking, detail: detail) }
        if var turn = ordinaryTurn, let client, let conversationId,
           turn.conversationId == conversationId {
            turn.cancellationRequested = true
            ordinaryTurn = turn
            cancelRequestedWithoutTaskID = turn.taskId == nil
            let version = connectionVersion
            if let taskId = turn.taskId {
                Task { await requestCancellation(taskId: taskId, client: client, version: version,
                    conversationId: conversationId, turnToken: turn.token) }
            } else {
                Task { await requestOperationCancellation(turnToken: turn.token, client: client,
                    version: version, conversationId: conversationId) }
            }
            return
        }
        guard let taskId = resumableTurn?.taskId, let client, let conversationId else { return }
        let version = connectionVersion
        Task { await requestCancellation(taskId: taskId, client: client, version: version, conversationId: conversationId) }
    }

    private func requestOperationCancellation(
        turnToken: UUID,
        client: APIClient,
        version: Int,
        conversationId: String
    ) async {
        guard let turn = ordinaryTurn, turn.token == turnToken else { return }
        do {
            let receipt = try await client.cancelChatOperation(
                conversationId: turn.conversationId, clientOperationId: turn.operationId
            )
            guard isCurrentOrdinaryTurn(turnToken, client: client, version: version, conversationId: conversationId),
                  receipt.conversationId == turn.conversationId,
                  receipt.clientOperationId == turn.operationId else { return }
            if receipt.outcome == .cancelledBeforeAdmission, receipt.taskId == nil,
               receipt.effectStatus == "not_started" {
                settleCancelledBeforeAdmission(turnToken: turnToken, text: turn.ownerText,
                    draftScope: conversationDrafts.scope(conversationID: conversationId))
                return
            }
            if let taskId = receipt.taskId {
                guard let taskStatus = receipt.taskStatus,
                      ["cancelled", "done", "failed"].contains(taskStatus) else {
                    throw APIError.invalidResponse
                }
                settleOperationCancellation(
                    turnToken: turnToken,
                    taskId: taskId,
                    taskStatus: taskStatus,
                    outcome: receipt.outcome
                )
            } else {
                isCancellingSend = false
                errorMessage = "The stop outcome is unknown. Retry checking this same turn before sending another message."
                setActivityThought(.thinking, proposedDetail: "Stop status unknown. Checking the same turn.")
            }
        } catch {
            guard isCurrentOrdinaryTurn(turnToken, client: client, version: version, conversationId: conversationId) else { return }
            isCancellingSend = false
            errorMessage = "The stop outcome is unknown. Retry checking this same turn before sending another message."
            setActivityThought(.thinking, proposedDetail: "Stop status unknown. Checking the same turn.")
        }
    }

    /// A terminal cancellation receipt is an authoritative task observation.
    /// It lets the owner continue even if the original event stream never closes.
    /// Cancellation does not promise that an external effect was rolled back.
    private func settleOperationCancellation(
        turnToken: UUID,
        taskId: String,
        taskStatus: String,
        outcome: ChatOperationCancellationOutcome
    ) {
        guard let turn = ordinaryTurn, turn.token == turnToken,
              turn.taskId == nil || turn.taskId == taskId else { return }
        let notice: String
        let detail: String
        let thought: AssistantThought
        switch (outcome, taskStatus) {
        case (.cancelled, "cancelled"), (.alreadyCancelled, "cancelled"):
            notice = Self.cancelledTaskEffectNotice
            detail = "Task cancelled; external effects are not reversed"
            thought = .stopped
        case (.alreadyTerminal, "done"):
            notice = "This task finished before the stop request was processed."
            detail = "Task finished before stop"
            thought = .finished
        case (.alreadyTerminal, "failed"):
            notice = "This task failed before the stop request was processed."
            detail = "Task failed before stop"
            thought = .stopped
        default:
            return
        }
        pollTask?.cancel()
        pollTask = nil
        if messages.contains(where: { $0.id == turn.streamID && $0.text.isEmpty }) {
            messages.removeAll { $0.id == turn.streamID && $0.text.isEmpty }
        }
        spokenTurn = nil
        ordinaryTurn = nil
        resumableTurn = nil
        isSending = false
        isCancellingSend = false
        cancelRequestedWithoutTaskID = false
        errorMessage = notice
        setActivityThought(thought, proposedDetail: detail)
    }

    private func requestCancellation(
        taskId: String,
        client: APIClient,
        version: Int,
        conversationId: String,
        turnToken: UUID? = nil
    ) async {
        do {
            try await client.updateActivity(id: taskId, action: "cancel")
            guard connectionIsCurrent(client, version: version), self.conversationId == conversationId,
                  resumableTurn?.taskId == taskId,
                  turnToken == nil || ordinaryTurn?.token == turnToken else { return }
            setActivityThought(.thinking, proposedDetail: "Stop request received. Checking the task outcome.")
        } catch {
            guard connectionIsCurrent(client, version: version), self.conversationId == conversationId,
                  resumableTurn?.taskId == taskId,
                  turnToken == nil || ordinaryTurn?.token == turnToken else { return }
            // A timeout or conflict does not establish whether cancellation
            // won. The existing poll continues to reconcile the same task.
            isCancellingSend = false
            errorMessage = "The stop request was not confirmed. I’m checking the current task status."
            setActivityThought(.thinking, proposedDetail: "Stop status unknown. Checking the current task.")
        }
    }

    func dismissError() { errorMessage = nil }

    /// ChatView takes the failed turn's text back into its composer, once.
    func restoreFailedDraft() -> String? {
        let draft = restorableDraft
        restorableDraft = nil
        return draft
    }

#if DEBUG
    func previewActivitySequence() {
        thoughtClearTask?.cancel()
        Task { [weak self] in
            guard let self else { return }
            self.setActivityThought(.thinking, proposedDetail: "Preparing a focused brief")
            await LiveActivityManager.shared.start(
                agentName: self.agentName,
                thought: .thinking,
                detail: "Preparing a focused brief"
            )
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            let working = AssistantThought(label: "Reviewing recent activity", tone: .working)
            self.setActivityThought(working, proposedDetail: "Step 1")
            await LiveActivityManager.shared.update(thought: working, detail: "Step 1")
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self.setActivityThought(.needsYou, proposedDetail: "Review the proposed next step")
            await LiveActivityManager.shared.needsAttention(
                agentName: agentName,
                detail: "Review the proposed next step",
                pendingCount: 1
            )
        }
    }
#endif

    private func apply(_ response: BootstrapResponse, preservingLocalMessages: Bool = false) {
        let changedOwner = bootstrap.map { $0.identity.id != response.identity.id } ?? false
        if changedOwner {
            // An installation can be replaced behind the same URL and key.
            // Authentication of the new bootstrap does not make old private
            // caches or delayed responses belong to the new identity.
            connectionVersion += 1
            activityConnectionRevision += 1
            resetConnectedState()
        }
        if let client {
            edits.configureRecovery(scope: client.configuration.baseURL.absoluteString + "|" + response.identity.id)
        }
        bootstrap = response
        applyMemoryHealth(response.shell.memoryHealth)
        if activeConversation == nil
            || activeConversation?.conversation.id == response.conversation.conversation.id {
            activeConversation = response.conversation
            cursor = response.conversation.cursor
            if preservingLocalMessages {
                merge(response.conversation.messages)
            } else {
                messages = logOrder.ordered(response.conversation.messages.map { withLocalDecisions($0) })
            }
        }
        if !isSending, activityThought == nil || activityThought == .backgroundWork || activityThought == .needsYou {
            setActivityThought(baselineThought, proposedDetail: baselineDetail(for: baselineThought))
        }
        if changedOwner, isSceneActive { startIdlePolling() }
    }

    /// The badge appears in the chat directory while review mutations refresh
    /// the workspace projection. Keep it synchronized with whichever current
    /// server projection arrived most recently instead of pinning it to the
    /// cold-launch bootstrap response.
    func applyMemoryHealth(_ health: MemoryHealth) {
        memoryReviewCount = max(0, health.awaitingReview)
    }

    private func setActiveConversation(_ conversation: ConversationView) {
        if conversation.conversation.id != self.conversationId,
           ordinaryTurn == nil, resumableTurn == nil {
            // A pending form admission belongs to the conversation being left.
            // Its eventual response may still settle the encrypted operation,
            // but it no longer owns the new conversation's composer state.
            isSending = false
            isCardFormAdmissionPending = false
        }
        conversationIntentGeneration += 1
        stopIdlePolling()
        // Another conversation's reply has no business still being read here.
        stopSpeaking()
        activeConversation = conversation
        cursor = conversation.cursor
        // Another conversation's ids have no sequence to agree with this one's.
        logOrder.reset()
        messages = logOrder.ordered(conversation.messages.map { withLocalDecisions($0) })
        toolActivity = []
        activityThought = nil
        if isSceneActive { startIdlePolling() }
    }

    private func receive(delta: String, streamID: String, client: APIClient, version: Int, conversationId: String, turnToken: UUID? = nil) async {
        guard connectionIsCurrent(client, version: version), self.conversationId == conversationId,
              turnToken == nil || ordinaryTurn?.token == turnToken else { return }
        append(delta: delta, to: streamID)
        await publishThought(.replying, detail: "Writing a response")
    }

    private func receive(cue: MessagePart, streamID: String, client: APIClient, version: Int, conversationId: String, turnToken: UUID? = nil) {
        guard connectionIsCurrent(client, version: version), self.conversationId == conversationId,
              turnToken == nil || ordinaryTurn?.token == turnToken else { return }
        append(cue: cue, to: streamID)
    }

    private func append(delta: String, to id: String) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        // The LAST text part is the live bubble: a data-break cue starts a
        // fresh one, and everything after it belongs to the new bubble.
        if let partIndex = messages[index].parts.lastIndex(where: { $0.type == "text" }) {
            messages[index].parts[partIndex].text = (messages[index].parts[partIndex].text ?? "") + delta
        }
    }

    private func append(cue: MessagePart, to id: String) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        // A bubble boundary, not overlay data: the reply's remaining text
        // belongs to a fresh bubble. Persisted twins arrive already split, so
        // this only mirrors the boundary into the in-flight stream message.
        if cue.type == "data-break" {
            messages[index].parts.append(MessagePart(type: "text", text: ""))
            return
        }
        messages[index].parts.append(cue)
    }

    /// Automatic speech is deferred until the durable response can be checked
    /// for approvals and sensitive card content.
    private struct SpokenTurn {
        let streamID: String
        let previousAssistantMessageIDs: Set<String>
    }

    /// Record the durable replies that predate this turn so reconciliation
    /// cannot accidentally read an older assistant row.
    private func beginSpeaking(streamID: String) {
        SpeechPlayer.shared.stop()
        guard speechAlwaysOn || SpeechSettings.speakRepliesAloud else {
            spokenTurn = nil
            return
        }
        let previous = Set(messages.compactMap { message in
            message.role == .assistant && !message.id.hasPrefix("stream-") ? message.id : nil
        })
        spokenTurn = SpokenTurn(streamID: streamID, previousAssistantMessageIDs: previous)
    }

    /// Speak only after the durable row gives privacy classification the full
    /// approval and card payload.
    private func finishSpeaking(for message: ChatMessage) {
        guard let turn = spokenTurn,
              message.role == .assistant,
              message.id != turn.streamID,
              !message.id.hasPrefix("stream-"),
              !turn.previousAssistantMessageIDs.contains(message.id) else { return }
        spokenTurn = nil
        enqueueAutomaticSpeech(message)
    }

    func stopSpeaking() {
        spokenTurn = nil
        SpeechPlayer.shared.stop()
    }

    /// A terminal task row can arrive before its durable assistant message.
    /// Keep the notice tied to the exact session and task so an unrelated
    /// later message cannot dismiss it.
    func recordCompletedTaskWithoutReply(taskId: String) {
        guard let conversationId, let ownerID = bootstrap?.identity.id else { return }
        missingTaskReplyNotice = MissingTaskReplyNotice(
            ownerID: ownerID,
            conversationID: conversationId,
            taskID: taskId,
            connectionVersion: connectionVersion
        )
        errorMessage = Self.completedTaskReplyUnavailableMessage
    }

    private func isVisibleDurableAssistantReply(_ message: ChatMessage) -> Bool {
        guard message.role == .assistant, !message.id.hasPrefix("stream-") else { return false }
        return message.parts.contains { part in
            (part.type == "text" && !(part.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                || (part.type == "data-card" && MessageResponseCard(part: part, formRendererAvailable: true) != nil)
        }
    }

    private func pollForReply(taskId: String?, streamID: String, ordinaryTurnToken: UUID? = nil) async {
        guard let client, let conversationId else { return }
        let version = connectionVersion
        let settled = Set(["done", "failed", "cancelled", "waiting_approval", "waiting_budget", "needs_attention"])
        let attention = Set(["waiting_approval", "waiting_budget", "needs_attention"])
        var grace = 0
        var finalStatus: String?
        var receivedCurrentReply = false
        var currentReplyMessageIDs = Set<String>()
        let assistantMessageIDsAtStart = Set(messages.compactMap { message in
            message.role == .assistant && !message.id.hasPrefix("stream-") ? message.id : nil
        })
        func refreshCurrentReplyState() {
            currentReplyMessageIDs = Set(messages.compactMap { message in
                guard isVisibleDurableAssistantReply(message) else { return nil }
                if let taskId {
                    return message.metadata?["taskId"]?.string == taskId ? message.id : nil
                }
                return !assistantMessageIDsAtStart.contains(message.id) ? message.id : nil
            })
            receivedCurrentReply = !currentReplyMessageIDs.isEmpty
        }
        refreshCurrentReplyState()
        // A held poll waits on the server, so the loop is bounded by how long a
        // turn may legitimately take rather than by a count of ticks.
        let deadline = Date().addingTimeInterval(30 * 60)
        var attempt = -1
        // Kept at the top of the loop, where the old fixed interval was, so
        // that every `continue` below still backs off rather than spinning.
        var gapMilliseconds: Int64 = 0
        while Date() < deadline {
            attempt += 1
            guard connectionIsCurrent(client, version: version), self.conversationId == conversationId,
                  ordinaryTurnToken == nil || ordinaryTurn?.token == ordinaryTurnToken else { return }
            if gapMilliseconds > 0 {
                try? await Task.sleep(for: .milliseconds(gapMilliseconds))
            }
            guard connectionIsCurrent(client, version: version), self.conversationId == conversationId,
                  ordinaryTurnToken == nil || ordinaryTurn?.token == ordinaryTurnToken else { return }
            do {
                let startedAt = Date()
                let updates = try await client.updates(
                    conversationId: conversationId,
                    taskId: taskId,
                    cursor: cursor,
                    refreshIds: unresolvedDecisionMessageIDs,
                    waitMilliseconds: PollingPolicy.holdMilliseconds
                )
                guard connectionIsCurrent(client, version: version), self.conversationId == conversationId,
                  ordinaryTurnToken == nil || ordinaryTurn?.token == ordinaryTurnToken else { return }
                let elapsedMilliseconds = Int64(Date().timeIntervalSince(startedAt) * 1_000)
                merge(updates.messages)
                merge(updates.refreshed)
                removeSuperseded(updates.superseded)
                toolActivity = updates.activity
                if let latestTool = updates.activity.last {
                    await publishThought(
                        latestTool.inProgressThought,
                        detail: "Step \(latestTool.step)"
                    )
                }
                guard connectionIsCurrent(client, version: version), self.conversationId == conversationId,
                  ordinaryTurnToken == nil || ordinaryTurn?.token == ordinaryTurnToken else { return }
                if let nextCursor = updates.nextCursor { cursor = nextCursor }
                refreshCurrentReplyState()
                gapMilliseconds = PollingPolicy.gapMilliseconds(
                    elapsedMilliseconds: elapsedMilliseconds,
                    // `superseded` is optional on the wire — a server that sent
                    // no retractions omits it entirely.
                    carriedNews: !updates.messages.isEmpty
                        || !updates.refreshed.isEmpty
                        || !(updates.superseded?.isEmpty ?? true),
                    attempt: attempt,
                    hasTaskID: taskId != nil
                )

                if taskId == nil, receivedCurrentReply {
                    messages.removeAll { $0.id == streamID }
                    break
                }
                if let status = updates.taskStatus {
                    if let taskId { observeCardFormTask(status, taskId: taskId) }
                    if settled.contains(status) {
                        finalStatus = status
                        grace += 1
                        if receivedCurrentReply || grace >= 4 { break }
                        if updates.hasMore { continue }
                    }
                }
                if updates.hasMore { continue }
            } catch {
                // Same as above: a poll interrupted by cancelSend must not
                // report itself as a failure.
                guard connectionIsCurrent(client, version: version), self.conversationId == conversationId,
                  ordinaryTurnToken == nil || ordinaryTurn?.token == ordinaryTurnToken else { return }
                // A failed poll never held anything, so fall back to the timed
                // cadence rather than retrying as fast as the network allows.
                gapMilliseconds = PollingPolicy.replyIntervalMilliseconds(
                    attempt: attempt,
                    hasTaskID: taskId != nil
                )
                if isRequestCancellation(error) { continue }
                if attempt > 3 {
                    reportError(error)
                    break
                }
            }
        }
        guard connectionIsCurrent(client, version: version), self.conversationId == conversationId,
                  ordinaryTurnToken == nil || ordinaryTurn?.token == ordinaryTurnToken else { return }
        refreshCurrentReplyState()
        if finalStatus == nil && (!receivedCurrentReply || cancelRequestedWithoutTaskID) {
            spokenTurn = nil
            isSending = false
            isCancellingSend = false
            errorMessage = "The task outcome is unknown. Reconnect to reconcile its status before starting another turn."
            setActivityThought(.thinking, proposedDetail: "Task status unknown. Reconnect to check the outcome.")
            return
        }
        if finalStatus == "cancelled" {
            // A cancelled task status does not prove that an external handler
            // rolled back work that had already started.
            errorMessage = Self.cancelledTaskEffectNotice
        }
        toolActivity = []
        if let taskId, let finalStatus, ["done", "failed", "cancelled"].contains(finalStatus) {
            observeCardFormTask(finalStatus, taskId: taskId)
        }
        let settlement = notificationTurnSettlements.begin()
        defer { notificationTurnSettlements.finish(settlement) }
        isSending = false
        isCancellingSend = false
        resumableTurn = nil
        await refreshOverview(reportFailure: false)
        guard connectionIsCurrent(client, version: version), self.conversationId == conversationId,
                  ordinaryTurnToken == nil || ordinaryTurn?.token == ordinaryTurnToken else { return }
        // A completed turn may have created or cancelled a reminder. Refresh
        // the secondary workspace projection at the same authoritative
        // boundary as the overview so More → Reminders cannot show a stale
        // inventory after returning from Chat.
        await refreshWorkspace(reportFailure: false)
        guard connectionIsCurrent(client, version: version), self.conversationId == conversationId,
                  ordinaryTurnToken == nil || ordinaryTurn?.token == ordinaryTurnToken else { return }
        refreshCurrentReplyState()
        if let turn = spokenTurn {
            let durableReply = messages.reversed().first { message in
                message.role == .assistant
                    && !message.id.hasPrefix("stream-")
                    && currentReplyMessageIDs.contains(message.id)
                    && !turn.previousAssistantMessageIDs.contains(message.id)
            }
            if let durableReply { finishSpeaking(for: durableReply) }
            else { spokenTurn = nil }
        }

        let reply = messages.reversed().first(where: {
            currentReplyMessageIDs.contains($0.id) && $0.role == .assistant && !$0.text.isEmpty
        })?.text
        if let finalStatus, attention.contains(finalStatus) {
            let matchingApproval = finalStatus == "waiting_approval"
                ? overview?.approvals.pending.first(where: { $0.approval.taskId == taskId })
                : nil
            if let matchingApproval {
                let summary = matchingApproval.approval.summary
                setActivityThought(.needsYou, proposedDetail: summary)
                await LiveActivityManager.shared.needsAttention(
                    agentName: self.agentName,
                    detail: summary,
                    pendingCount: pendingApprovalCount
                )
                guard connectionIsCurrent(client, version: version), self.conversationId == conversationId,
                      ordinaryTurnToken == nil || ordinaryTurn?.token == ordinaryTurnToken else { return }
                _ = await notifyOnce(
                    key: "\(taskId ?? streamID)-\(finalStatus)",
                    title: "\(agentName) needs you",
                    body: "A decision is ready to review.",
                    route: .approvals,
                    approvalId: matchingApproval.id
                )
            } else {
                let detail = "This task needs attention. Open the chat for details."
                setActivityThought(.needsYou, proposedDetail: detail)
                await syncApprovalSurfaces()
                guard connectionIsCurrent(client, version: version), self.conversationId == conversationId,
                      ordinaryTurnToken == nil || ordinaryTurn?.token == ordinaryTurnToken else { return }
                _ = await notifyOnce(
                    key: "\(taskId ?? streamID)-\(finalStatus)",
                    title: "\(agentName) needs attention",
                    body: "Open the chat to see what needs your attention.",
                    route: .chat
                )
            }
            guard connectionIsCurrent(client, version: version), self.conversationId == conversationId,
                  ordinaryTurnToken == nil || ordinaryTurn?.token == ordinaryTurnToken else { return }
            await syncNotificationBadge()
        } else {
            let completedWithoutReply = finalStatus == "done" && !receivedCurrentReply
            let succeeded = finalStatus != "failed" && finalStatus != "cancelled" && !completedWithoutReply
            let thought: AssistantThought = completedWithoutReply
                ? .replyUnavailable
                : succeeded ? .finished : .stopped
            let detail = completedWithoutReply
                ? "This task is marked complete, but its reply has not appeared yet."
                : finalStatus == "cancelled"
                ? "Task cancelled; external effects are not reversed"
                : concise(reply ?? (succeeded ? "Your assistant finished the task." : "Open the conversation for details."))
            if completedWithoutReply {
                if let taskId {
                    recordCompletedTaskWithoutReply(taskId: taskId)
                } else {
                    errorMessage = detail
                }
            }
            setActivityThought(thought, proposedDetail: detail)
            _ = await notifyOnce(
                key: "\(taskId ?? streamID)-\(finalStatus ?? "reply")",
                title: completedWithoutReply ? "Task complete; reply not yet available" : succeeded ? "\(agentName) finished" : "\(agentName) stopped",
                body: succeeded ? "Your result is ready." : "Open the conversation to check the task.",
                route: .chat
            )
            guard connectionIsCurrent(client, version: version), self.conversationId == conversationId,
                  ordinaryTurnToken == nil || ordinaryTurn?.token == ordinaryTurnToken else { return }
            await LiveActivityManager.shared.finish(
                thought: thought,
                detail: detail,
                succeeded: succeeded
            )
            guard connectionIsCurrent(client, version: version), self.conversationId == conversationId,
                  ordinaryTurnToken == nil || ordinaryTurn?.token == ordinaryTurnToken else { return }
            clearThought(after: succeeded ? 1.8 : 4)
        }
        guard connectionIsCurrent(client, version: version), self.conversationId == conversationId,
                  ordinaryTurnToken == nil || ordinaryTurn?.token == ordinaryTurnToken else { return }
        notificationTurnSettlements.finish(settlement)
        await resolvePendingNotificationDestination()
        if let ordinaryTurnToken, ordinaryTurn?.token == ordinaryTurnToken {
            ordinaryTurn = nil
        }
    }

    /// The merge above can only add or replace by id. A state row delivered by
    /// an earlier poll and later replaced by a newer twin (a crash-retry
    /// re-emitting a task's stop notice) sits behind the cursor forever, so
    /// the server names it for removal — applied after every merge, since a
    /// refreshed card can itself be the row being replaced.
    private func removeSuperseded(_ ids: [String]?) {
        guard let ids, !ids.isEmpty else { return }
        let retracted = Set(ids)
        messages.removeAll { retracted.contains($0.id) }
    }

    private func merge(_ incoming: [ChatMessage]) {
        for incomingMessage in incoming {
            let message = withLocalDecisions(incomingMessage)
            if let index = messages.firstIndex(where: { $0.id == message.id }) {
                messages[index] = message
                continue
            }
            if let localIndex = messages.firstIndex(where: {
                $0.id.hasPrefix("local-") && $0.role == message.role && $0.text == message.text
            }) {
                messages.remove(at: localIndex)
            }
            if message.role == .assistant {
                messages.removeAll {
                    $0.id.hasPrefix("stream-") && ($0.text == message.text || !$0.text.isEmpty)
                }
            }
            messages.append(message)
        }
        messages = logOrder.ordered(messages)
    }

    private func stopIdlePolling() {
        idlePollingVersion += 1
        idleTask?.cancel()
        idleTask = nil
    }

    private func startIdlePolling() {
        stopIdlePolling()
        idleTask = Task { [weak self] in
            var unchangedPolls = 0
            // The server holds this poll open, so the sleep below is only the
            // gap between holds — against a server that does not hold, it stays
            // the timed backoff it has always been.
            var gapSeconds = PollingPolicy.idleIntervalSeconds(unchangedPolls: 0)
            while !Task.isCancelled {
                if gapSeconds > 0 {
                    try? await Task.sleep(for: .seconds(gapSeconds))
                }
                guard !Task.isCancelled, let self, self.isSceneActive else { return }
                let startedAt = Date()
                if let changed = await self.refreshIdleConversation() {
                    unchangedPolls = changed ? 0 : unchangedPolls + 1
                    gapSeconds = PollingPolicy.idleGapSeconds(
                        elapsedMilliseconds: Int64(Date().timeIntervalSince(startedAt) * 1_000),
                        unchangedPolls: unchangedPolls
                    )
                } else {
                    unchangedPolls += 1
                    // A failed poll held nothing; back off on the timed cadence.
                    gapSeconds = PollingPolicy.idleIntervalSeconds(unchangedPolls: unchangedPolls)
                }
            }
        }
    }

    /// One held idle read, fenced to its original thread, owner, and cursor.
    /// Cancellation can race a completed URLSession response, so cancelling
    /// the task alone is insufficient to protect a newly opened conversation.
    @discardableResult
    func refreshIdleConversation() async -> Bool? {
        guard !Task.isCancelled, isSceneActive, !isSending,
              !notificationTurnSettlements.isSettling,
              let client, let conversationId, let ownerID = bootstrap?.identity.id else { return nil }
        let version = idlePollingVersion
        let connectionRevision = connectionVersion
        let requestCursor = cursor
        let notificationTitle = "\(agentName) replied"
        guard let updates = try? await client.updates(
            conversationId: conversationId,
            taskId: nil,
            cursor: requestCursor,
            refreshIds: unresolvedDecisionMessageIDs,
            waitMilliseconds: PollingPolicy.holdMilliseconds
        ) else { return nil }
        guard !Task.isCancelled, isSceneActive, !isSending,
              !notificationTurnSettlements.isSettling,
              idlePollingVersion == version,
              connectionVersion == connectionRevision,
              self.client?.configuration == client.configuration,
              self.conversationId == conversationId,
              bootstrap?.identity.id == ownerID,
              cursor == requestCursor else { return nil }

        let changed = !updates.messages.isEmpty || !updates.refreshed.isEmpty ||
            !(updates.superseded?.isEmpty ?? true)
        let visibleAssistantIDsBefore = Set(messages.compactMap { message in
            isVisibleDurableAssistantReply(message) ? message.id : nil
        })
        let decisionsBefore = openDecisionSignature
        merge(updates.messages)
        merge(updates.refreshed)
        removeSuperseded(updates.superseded)
        if let cursor = updates.nextCursor { self.cursor = cursor }
        let visibleAssistantIDsAfter = Set(messages.compactMap { message in
            isVisibleDurableAssistantReply(message) ? message.id : nil
        })
        let newlyVisibleAssistantIDs = visibleAssistantIDsAfter.subtracting(visibleAssistantIDsBefore)
        if let notice = missingTaskReplyNotice,
           notice.ownerID == ownerID,
           notice.conversationID == conversationId,
           notice.connectionVersion == connectionRevision,
           errorMessage == Self.completedTaskReplyUnavailableMessage,
           messages.contains(where: {
               $0.metadata?["taskId"]?.string == notice.taskID
                   && isVisibleDurableAssistantReply($0)
           }) {
            missingTaskReplyNotice = nil
            errorMessage = nil
        }
        // Decisions resolved elsewhere must refresh the Island, badge, and
        // inbox as well as the retained receipt in this conversation.
        if openDecisionSignature != decisionsBefore {
            Task { [weak self] in await self?.refreshOverview(reportFailure: false) }
        }
        if !newlyVisibleAssistantIDs.isEmpty,
           connectionVersion == connectionRevision,
           idlePollingVersion == version,
           self.client?.configuration == client.configuration,
           self.conversationId == conversationId,
           bootstrap?.identity.id == ownerID {
            await scheduleLocalNotification(
                notificationTitle,
                "A new response is ready.",
                .chat,
                nil,
                ownerID,
                conversationId
            )
        }
        return changed
    }

    /// Which messages still hold an open decision, and how many each. A change
    /// between two reads means the inbox changed under the phone.
    private var openDecisionSignature: [String: Int] {
        var open: [String: Int] = [:]
        for message in messages where message.hasPendingDecision {
            open[message.id] = message.approvalSummary?.pendingCount ?? 1
        }
        return open
    }

    /// Decision state lives in approvals/tasks rather than in the persisted
    /// message row. Re-read the newest visible cards during ordinary polling
    /// so a decision made on desktop changes into a receipt on the phone
    /// without requiring a reload. Suggestions ride along — answered on the
    /// web, or a snooze lapsing back into a question — without ever counting
    /// as a pending decision.
    private var unresolvedDecisionMessageIDs: [String] {
        let refreshing = messages.reversed().filter(\.hasRefreshingCard)
        let decisions = messages.reversed().filter { !$0.hasRefreshingCard && ($0.hasPendingDecision || $0.hasUnsettledSuggestion) }
        return (refreshing + decisions)
            .prefix(10)
            .map(\.id)
    }

    private func notifyOnce(key: String, title: String, body: String, route: AssistantRoute?, approvalId: String? = nil) async -> Bool {
        guard key != lastNotifiedTaskState else { return false }
        lastNotifiedTaskState = key
        return await scheduleLocalNotification(
            title, body, route, approvalId, bootstrap?.identity.id, conversationId
        )
    }

    /// The app icon badge tracks exactly one thing: decisions waiting on the
    /// owner. Anything else (finished work, replies) has a banner or the Live
    /// Activity, so the badge staying specific keeps it meaningful.
    private func syncNotificationBadge() async {
        await NotificationManager.shared.updateBadge(pendingApprovalCount)
    }

    private func publishThought(_ thought: AssistantThought, detail: String) async {
        let safeDetail = LiveActivityManager.safeDetail(for: thought, proposed: detail)
        guard activityThought != thought || activityDetail != safeDetail else { return }
        activityThought = thought
        activityDetail = safeDetail
        await LiveActivityManager.shared.update(thought: thought, detail: detail)
    }

    private func setActivityThought(_ thought: AssistantThought?, proposedDetail: String? = nil) {
        activityThought = thought
        if let thought, let proposedDetail {
            activityDetail = LiveActivityManager.safeDetail(for: thought, proposed: proposedDetail)
        } else {
            activityDetail = nil
        }
    }

    private func clearThought(after seconds: Double) {
        let settledThought = activityThought
        let settledDetail = activityDetail
        thoughtClearTask?.cancel()
        thoughtClearTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled, let self,
                  self.activityThought == settledThought,
                  self.activityDetail == settledDetail else { return }
            self.setActivityThought(
                self.baselineThought,
                proposedDetail: self.baselineDetail(for: self.baselineThought)
            )
        }
    }

    private var baselineThought: AssistantThought? {
        // The overview is refreshed far more often than bootstrap and carries
        // the actual approval rows. Only a real, currently pending owner
        // decision earns the system Island; generic attention stays in the
        // Activity surface so it cannot look like an approval.
        if let overview {
            return overview.approvals.pending.isEmpty ? nil : .needsYou
        }
        return (bootstrap?.shell.dashboard.pendingApprovals ?? 0) > 0 ? .needsYou : nil
    }

    private func baselineDetail(for thought: AssistantThought?) -> String? {
        switch thought {
        case .backgroundWork:
            nil
        case .needsYou:
            "Open the assistant to review the next step."
        default:
            nil
        }
    }

    private func reconcileBaselineActivity() async {
        guard !isSending else { return }
        guard let thought = baselineThought else {
            await LiveActivityManager.shared.dismiss()
            return
        }
        switch thought {
        case .backgroundWork:
            setActivityThought(thought, proposedDetail: "Your assistant is continuing a task.")
            await LiveActivityManager.shared.dismiss()
        case .needsYou:
            let summary = overview?.approvals.pending.first?.approval.summary
                ?? "Open the assistant to review the next step."
            setActivityThought(thought, proposedDetail: summary)
            await LiveActivityManager.shared.ensure(
                agentName: agentName,
                thought: .needsYou,
                detail: summary,
                pendingCount: pendingApprovalCount
            )
        default:
            await LiveActivityManager.shared.dismiss()
        }
    }

    private func concise(_ text: String, limit: Int = 120) -> String {
        let singleLine = text
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard singleLine.count > limit else { return singleLine }
        return String(singleLine.prefix(limit - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }

    private static func configuration(urlString: String, token: String) throws -> APIConfiguration {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              components.host != nil else { throw APIError.invalidServerURL }
        components.path = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = components.url else { throw APIError.invalidServerURL }
        return .init(baseURL: url, token: token.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
