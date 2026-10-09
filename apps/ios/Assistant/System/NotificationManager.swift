import SwiftUI
import UIKit
@preconcurrency import UserNotifications

/// A notification is navigation intent, never authority to access a thread.
/// The model verifies the owner and loads its destination through the server.
struct AssistantNotificationDestination: Equatable, Sendable {
    let route: AssistantRoute
    let agentID: String?
    let conversationID: String?

    init?(userInfo: [AnyHashable: Any]) {
        guard let rawRoute = userInfo["route"] as? String,
              let route = AssistantRoute(rawValue: rawRoute) else { return nil }
        self.route = route
        if let value = userInfo["agentId"] {
            guard let owner = value as? String, !owner.isEmpty, owner.count <= 128 else { return nil }
            agentID = owner
        } else {
            agentID = nil
        }
        conversationID = (userInfo["conversationId"] as? String)
            .flatMap { $0.count == 36 ? UUID(uuidString: $0)?.uuidString.lowercased() : nil }
    }

    func belongsTo(ownerID: String) -> Bool {
        agentID == nil || agentID == ownerID
    }
}

@MainActor
final class NotificationManager: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()

    @Published private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Published private(set) var isRequestingAuthorization = false
    @Published private(set) var authorizationError: String?
    @Published private(set) var pendingDestination: AssistantNotificationDestination?

    /// Wired up by AppModel: handles Approve/Deny actions taken directly on a
    /// notification without opening the app into the Approvals sheet first.
    var approvalDecisionHandler: (@MainActor (String, String, String) async -> Bool)?

    /// Wired up by AppModel: uploads the APNs device token to the owner's
    /// server so proactive notices reach the phone when the app is closed.
    var deviceTokenHandler: (@MainActor (String, String) async throws -> Void)?

    private let center: UNUserNotificationCenter
    private let defaults: UserDefaults
    private let uploadedTokenKey = "assistant.push-token-uploaded-scope"
    private var registrationScope: String?
    private var latestToken: String?

    // These raw identifiers do not touch manager state. Marking them
    // nonisolated lets UserNotifications delegate callbacks compare them
    // without crossing the main actor (a Swift 6 error otherwise).
    nonisolated static let attentionCategory = "ASSISTANT_ATTENTION"
    nonisolated static let updateCategory = "ASSISTANT_UPDATE"
    nonisolated static let approveAction = "ASSISTANT_APPROVE"
    nonisolated static let denyAction = "ASSISTANT_DENY"

    init(center: UNUserNotificationCenter = .current(), defaults: UserDefaults = .standard) {
        self.center = center
        self.defaults = defaults
        super.init()
        center.delegate = self
        registerCategories()
        Task { await refreshAuthorizationStatus() }
    }

    func requestAuthorization() async {
        guard !isRequestingAuthorization else { return }
        isRequestingAuthorization = true
        authorizationError = nil
        defer { isRequestingAuthorization = false }
        do {
            _ = try await center.requestAuthorization(options: [.alert, .sound])
        } catch {
            authorizationError = "Notifications couldn’t be enabled. Try again."
        }
        await refreshAuthorizationStatus()
    }

    func refreshAuthorizationStatus() async {
        authorizationStatus = await center.notificationSettings().authorizationStatus
    }

    /// APNs registration only makes sense once the owner has allowed
    /// notifications; call on connect and foreground. Registration is cheap
    /// and idempotent, and repeating it is how a rotated token reaches us.
    func registerForRemoteNotificationsIfAuthorized() async {
        await refreshAuthorizationStatus()
        guard authorizationStatus == .authorized || authorizationStatus == .provisional else {
            return
        }
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// The AppDelegate's token callback. Uploads are deduplicated so the
    /// per-launch callback doesn't spam the server, and the token is marked
    /// uploaded only after the server accepted it — a failed upload retries on
    /// the next registration callback (e.g. tomorrow's launch).
    func handleDeviceToken(_ data: Data) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        latestToken = token
        uploadTokenIfNeeded()
    }

    /// Token registration belongs to a server and authenticated owner. A
    /// token already sent to one pairing must be sent again after switching.
    func setRegistrationScope(_ scope: String?) {
        guard registrationScope != scope else { return }
        registrationScope = scope
        uploadTokenIfNeeded()
    }

    private func uploadTokenIfNeeded() {
        guard let token = latestToken, let scope = registrationScope,
              defaults.string(forKey: uploadedTokenKey) != Self.uploadMarker(token: token, scope: scope) else { return }
        Task { @MainActor [weak self] in
            guard let self, let handler = self.deviceTokenHandler else { return }
            do {
                try await handler(token, scope)
                guard self.registrationScope == scope, self.latestToken == token else { return }
                self.defaults.set(Self.uploadMarker(token: token, scope: scope), forKey: self.uploadedTokenKey)
            } catch {
                // Retry when either the token or authenticated scope is seen again.
            }
        }
    }

    private static func uploadMarker(token: String, scope: String) -> String {
        "\(scope)|\(token)"
    }

    @discardableResult
    func schedule(title: String, body: String, route: AssistantRoute?, approvalId: String? = nil,
                  agentID: String? = nil, conversationID: String? = nil) async -> Bool {
        let settings = await center.notificationSettings()
        authorizationStatus = settings.authorizationStatus
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional,
              UIApplication.shared.applicationState != .active else { return false }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = "assistant-work"
        content.categoryIdentifier = route == .approvals ? Self.attentionCategory : Self.updateCategory
        if let route {
            content.userInfo["route"] = route.rawValue
        }
        if let agentID { content.userInfo["agentId"] = agentID }
        if route == .chat, let conversationID, UUID(uuidString: conversationID) != nil {
            content.userInfo["conversationId"] = conversationID
        }
        if let approvalId {
            content.userInfo["approvalId"] = approvalId
        }

        let request = UNNotificationRequest(
            identifier: "assistant-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        do {
            try await center.add(request)
            return true
        } catch {
            return false
        }
    }

    /// Mirrors the pending-approval count onto the app icon badge. Zero clears
    /// it. Local notifications never touch the badge themselves, so this is
    /// the single place the number is asserted.
    func updateBadge(_ count: Int) async {
        do {
            try await center.setBadgeCount(max(0, count))
        } catch {
            // Badge failure is cosmetic — never surface it as an app error.
        }
    }

#if DEBUG
    @discardableResult
    func schedulePreview() async -> Bool {
        var status = await center.notificationSettings().authorizationStatus
        if status == .notDetermined {
            await requestAuthorization()
            status = authorizationStatus
        }
        guard status == .authorized || status == .provisional else { return false }

        let content = UNMutableNotificationContent()
        content.title = "Assistant needs you"
        content.body = "A decision is ready to review."
        content.sound = .default
        content.threadIdentifier = "assistant-work"
        content.categoryIdentifier = Self.attentionCategory
        content.userInfo["route"] = AssistantRoute.approvals.rawValue

        let request = UNNotificationRequest(
            identifier: "assistant-preview",
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false)
        )
        do {
            try await center.add(request)
            return true
        } catch {
            return false
        }
    }
#endif

    func consumePendingDestination(_ destination: AssistantNotificationDestination) {
        // An older asynchronous open must not consume a newer notification.
        if pendingDestination == destination { pendingDestination = nil }
    }

    func openSystemSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        // Notifications are normally suppressed while the app is active, but a
        // decision request is worth a banner even then: the owner may be on a
        // different screen and the work is parked until they respond.
        if notification.request.content.categoryIdentifier == Self.attentionCategory {
            return [.banner, .sound]
        }
        return []
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo

        // Inline Approve/Deny actions resolve the approval in place and skip
        // navigation entirely — the handler refreshes the model behind them.
        if response.actionIdentifier == Self.approveAction
            || response.actionIdentifier == Self.denyAction,
            let approvalId = userInfo["approvalId"] as? String,
            let destination = AssistantNotificationDestination(userInfo: userInfo),
            let ownerID = destination.agentID,
            destination.route == .approvals {
            let decision = response.actionIdentifier == Self.approveAction ? "approved" : "denied"
            if let handler = await MainActor.run(body: { self.approvalDecisionHandler }) {
                if await handler(approvalId, decision, ownerID) { return }
            }
        }

        guard let destination = AssistantNotificationDestination(userInfo: userInfo) else { return }
        await MainActor.run { self.pendingDestination = destination }
    }

    private func registerCategories() {
        // Authentication is required for both: an approval button that works
        // from the lock screen without unlocking would let anyone holding the
        // phone authorize an outward-facing action.
        let approve = UNNotificationAction(
            identifier: Self.approveAction,
            title: "Approve",
            options: [.authenticationRequired]
        )
        let deny = UNNotificationAction(
            identifier: Self.denyAction,
            title: "Deny",
            options: [.authenticationRequired, .destructive]
        )
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: Self.attentionCategory,
                actions: [approve, deny],
                intentIdentifiers: [],
                hiddenPreviewsBodyPlaceholder: "Decision ready",
                options: []
            ),
            UNNotificationCategory(
                identifier: Self.updateCategory,
                actions: [],
                intentIdentifiers: [],
                hiddenPreviewsBodyPlaceholder: "Assistant update",
                options: []
            ),
        ])
    }
}
