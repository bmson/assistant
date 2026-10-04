import SwiftUI
import UIKit

/// UIApplicationDelegate only for the APNs token callbacks — everything else
/// lives in the SwiftUI scene. Registration itself is triggered by
/// NotificationManager once the owner has granted notification permission.
final class AssistantAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            NotificationManager.shared.handleDeviceToken(deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Simulator without a sandbox account, or a missing entitlement —
        // push is best-effort; local notifications keep working regardless.
    }
}

@main
struct AssistantApp: App {
    @UIApplicationDelegateAdaptor(AssistantAppDelegate.self) private var appDelegate
    @State private var model = AppModel()
    // Dark by default: the owner expects the conversation stage day and
    // night, and a silently followed system appearance read as a bug.
    @AppStorage(AssistantAppearance.defaultsKey) private var appearance = AssistantAppearance.dark

    init() {
        // Set the notification delegate and register categories before iOS can
        // deliver a launch response from a tapped notification.
        _ = NotificationManager.shared
        // A background launch for a significant location change must find the
        // location manager listening: constructing it here (not lazily on a
        // foreground access) is what resumes monitoring after a relaunch.
        _ = LocationManager.shared
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(appearance.colorScheme)
        }
    }
}
