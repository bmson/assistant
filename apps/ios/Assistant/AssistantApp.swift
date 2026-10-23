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
        #if !ASSISTANT_SCROLL_FIXTURE
        Task { @MainActor in
            NotificationManager.shared.handleDeviceToken(deviceToken)
        }
        #endif
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
    #if ASSISTANT_SCROLL_FIXTURE
    @State private var model = ScrollFixture.makeModel()
    #else
    @State private var model = AppModel()
    // Dark by default: the owner expects the conversation stage day and
    // night, and a silently followed system appearance read as a bug.
    @AppStorage(AssistantAppearance.defaultsKey) private var appearance = AssistantAppearance.dark
    #endif

    init() {
        #if !ASSISTANT_SCROLL_FIXTURE
        // Set the notification delegate and register categories before iOS can
        // deliver a launch response from a tapped notification.
        _ = NotificationManager.shared
        // A background launch for a significant location change must find the
        // location manager listening: constructing it here (not lazily on a
        // foreground access) is what resumes monitoring after a relaunch.
        _ = LocationManager.shared
        #endif
    }

    var body: some Scene {
        WindowGroup {
            #if ASSISTANT_SCROLL_FIXTURE
            ScrollFixtureRoot(model: model)
            #else
            RootView()
                .environment(model)
                .preferredColorScheme(appearance.colorScheme)
            #endif
        }
    }
}
