import SwiftUI
import UIKit

@MainActor
struct GoogleCalendarConnectionView: View {
    @Environment(AppModel.self) private var model
    @State private var coordinator = GoogleCalendarConnectionCoordinator()
    @State private var window: UIWindow?
    @State private var confirmingDisconnect = false
    @State private var isVisible = false

    var body: some View {
        AssistantSettingsList {
            Section("Google Calendar") {
                Text("Optionally connect your Google Calendar to read events when answering calendar questions. Event creation, when available, needs separate permission and your approval. Gmail and Drive aren’t included.")
                    .font(.subheadline).foregroundStyle(.secondary)
                Text("Once connected, your personal Google account becomes the default for ordinary calendar questions. If personal access fails, Assistant won’t automatically fall back to the assistant account.")
                    .font(.subheadline).foregroundStyle(.secondary)
                if let status = coordinator.status {
                    if let account = status.account {
                        Text("Personal Google account").font(.caption).foregroundStyle(.secondary)
                        Text(account.email).textSelection(.enabled)
                        Text(status.isReady && !coordinator.couldNotCheck
                             ? (status.canCreateEvents ? "Connected · Read access and event creation" : "Connected · Read-only")
                             : statusLabel(status))
                            .font(.subheadline).foregroundStyle(.secondary)
                    } else {
                        Text(statusLabel(status)).font(.subheadline).foregroundStyle(.secondary)
                    }
                    if status.configured {
                        Button(status.account == nil ? "Connect Google Calendar" : "Reconnect Google Calendar") {
                            guard let window else { return }
                            Task { await coordinator.connect(anchor: window) }
                        }
                        .buttonStyle(AssistantActionButtonStyle(kind: status.isReady ? .secondary : .primary, fillsWidth: true, minimumHeight: 44))
                        .disabled(coordinator.isBusy || window == nil || coordinator.couldNotCheck)
                        if status.canRequestEventCreation && !coordinator.couldNotCheck {
                            Text("Allow event creation for \(status.account?.email ?? "this personal account"). Read access works without this permission. You’ll still review each event’s calendar, title, time and guests before it’s created.")
                                .font(.subheadline).foregroundStyle(.secondary)
                            Button("Allow event creation") {
                                guard let window else { return }
                                Task { await coordinator.upgradeWriteAccess(anchor: window) }
                            }
                            .buttonStyle(AssistantActionButtonStyle(kind: .primary, fillsWidth: true, minimumHeight: 44))
                            .disabled(coordinator.isBusy || window == nil)
                            .accessibilityIdentifier("google-calendar-allow-event-creation")
                        }
                        if status.canCreateEvents && !coordinator.couldNotCheck {
                            Text("Event creation is allowed for this personal account. Each event still needs your approval in Assistant.")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        if status.isReady && !coordinator.couldNotCheck {
                            Text("Ask your assistant about upcoming events or your agenda. Calendar answers use this Google account.")
                                .font(.subheadline).foregroundStyle(.secondary)
                            Button("Open chat") { model.returnToChat() }
                                .buttonStyle(AssistantActionButtonStyle(kind: .secondary, fillsWidth: true, minimumHeight: 44))
                        } else if status.canRetryCalendarInChat && !coordinator.couldNotCheck {
                            Text("Ask a calendar question in chat to retry existing access without another sign-in. Refresh connection status only checks the saved status.")
                                .font(.subheadline).foregroundStyle(.secondary)
                            Button("Try Calendar in chat") { model.returnToChat() }
                                .buttonStyle(AssistantActionButtonStyle(kind: .secondary, fillsWidth: true, minimumHeight: 44))
                                .disabled(coordinator.isBusy)
                        }
                    } else {
                        Text("Google Calendar connection isn’t configured on your assistant server yet. You can keep using Assistant without it.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    if status.account != nil {
                        Button("Disconnect Google Calendar", role: .destructive) { confirmingDisconnect = true }
                            .buttonStyle(AssistantActionButtonStyle(kind: .destructive, fillsWidth: true, minimumHeight: 44))
                            .disabled(coordinator.isBusy || coordinator.couldNotCheck)
                    } else {
                        Text("You can still explicitly ask to read the assistant account’s calendar. Assistant won’t automatically fall back to that account.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                } else if coordinator.isBusy {
                    ProgressView("Checking Google Calendar")
                } else if model.googleCalendarRequestContext() == nil {
                    Text("Connect to your assistant server to manage this optional connection.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                if coordinator.isBusy && coordinator.status != nil {
                    ProgressView("Checking connection…")
                }
                if coordinator.couldNotCheck {
                    AssistantInlineFailure(message: "Couldn’t check your Google Calendar connection. Any previous account shown was last confirmed earlier.")
                }
                if let notice = coordinator.notice {
                    Text(notice).font(.subheadline).foregroundStyle(.secondary).accessibilityIdentifier("google-calendar-notice")
                }
                Button("Refresh connection status") { Task { await coordinator.refresh() } }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, fillsWidth: true, minimumHeight: 44))
                    .disabled(coordinator.isBusy || model.googleCalendarRequestContext() == nil)
            }
        }
        .navigationTitle("Google Calendar")
        .assistantSubmenuChrome()
        .background(GoogleCalendarWindowReader(window: $window).frame(width: 0, height: 0))
        .task(id: model.activityConnectionVersion) {
            isVisible = true
            let context = model.googleCalendarRequestContext()
            coordinator.bind(service: context?.client) {
                guard let context else { return false }
                return isVisible && model.googleCalendarConnectionIsCurrent(context)
            }
            await coordinator.refresh()
        }
        .refreshable { await coordinator.refresh() }
        .onChange(of: coordinator.notice) { _, notice in
            if isVisible, let notice { AccessibilityNotification.Announcement(notice).post() }
        }
        .onChange(of: coordinator.couldNotCheck) { _, failed in
            if isVisible, failed {
                AccessibilityNotification.Announcement("Couldn’t check your Google Calendar connection. Refresh to check again.").post()
            }
        }
        .onDisappear {
            isVisible = false
            coordinator.unbind()
        }
        .confirmationDialog(
            "Disconnect \(coordinator.status?.account?.email ?? "Google Calendar")?",
            isPresented: $confirmingDisconnect,
            titleVisibility: .visible
        ) {
            Button("Disconnect", role: .destructive) { Task { await coordinator.disconnect() } }
        } message: {
            Text("This stops new calendar reads and event creation from this account. Your assistant account and iPhone calendar sharing stay as they are. You can still explicitly ask to read the assistant account’s calendar; there is no automatic fallback.")
        }
    }

    private func statusLabel(_ status: GoogleCalendarStatus) -> String {
        if coordinator.couldNotCheck { return "Couldn’t check connection" }
        switch status.state {
        case "unconfigured": return "Not configured"
        case "disconnected": return "Not connected"
        case "reconnect_required": return "Reconnect required"
        case "provider_unavailable": return "Google Calendar is temporarily unavailable"
        default: return "Connection could not be verified"
        }
    }
}

private struct GoogleCalendarWindowReader: UIViewRepresentable {
    @Binding var window: UIWindow?

    final class Probe: UIView {
        var changed: ((UIWindow?) -> Void)?
        override func didMoveToWindow() { super.didMoveToWindow(); changed?(window) }
    }

    func makeUIView(context: Context) -> Probe {
        let probe = Probe()
        probe.isUserInteractionEnabled = false
        probe.changed = { value in
            DispatchQueue.main.async { window = value }
        }
        return probe
    }

    func updateUIView(_ view: Probe, context: Context) {}
}
