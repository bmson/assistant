import EventKit
import SwiftUI

@MainActor
struct PhoneCalendarsView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var store: PhoneCalendarStore
    @State private var choosingCalendars = false
    @State private var confirmingDisconnect = false
    @State private var isVisible = false
    @Environment(\.openURL) private var openURL

    init(store: PhoneCalendarStore? = nil) {
        _store = State(initialValue: store ?? PhoneCalendarStore())
    }

    var body: some View {
        AssistantSettingsList {
            Section {
                Label("Calendars on this iPhone", systemImage: "calendar")
                    .font(.headline)
                Text("View events from calendars already synced to Apple Calendar. Choose which calendars to display.")
                    .foregroundStyle(.secondary)
                Text("Events stay on this iPhone. They aren’t uploaded, added to chat, or available to the assistant in the background.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if let error = store.errorMessage {
                Section { Text(error).foregroundStyle(.secondary) }
            }

            if store.access == .restricted {
                Section {
                    Label("Calendar access is restricted", systemImage: "lock.shield")
                    Text("Your device or workplace policy doesn’t allow access. Ask your administrator if this calendar can be used in Assistant.")
                        .foregroundStyle(.secondary)
                }
            } else if store.access == .denied || store.access == .writeOnly {
                Section {
                    Label("Calendar access is off", systemImage: "calendar.badge.exclamationmark")
                    Text("To display existing events, allow Full Access in iPhone Settings. Assistant only reads the calendars you select and never changes events.")
                        .foregroundStyle(.secondary)
                    Button("Open iPhone Settings") { openSettings() }
                }
            } else if !store.isEnabled {
                Section {
                    Button {
                        Task { await store.enable() }
                    } label: {
                        if store.isRequesting { ProgressView("Requesting access") }
                        else { Label("Use calendars on this iPhone", systemImage: "calendar.badge.plus") }
                    }
                    .disabled(store.isRequesting)
                } footer: {
                    Text("iOS calls this Full Access. Assistant uses it only to read and display the calendars you choose. Workplace restrictions still apply.")
                }
            } else {
                Section {
                    Button {
                        choosingCalendars = true
                    } label: {
                        HStack {
                            Label("Choose calendars", systemImage: "checklist")
                            Spacer()
                            Text("\(store.selectedIDs.count) selected").foregroundStyle(.secondary)
                        }
                    }
                    if store.calendars.isEmpty {
                        Text("No accessible calendars. Check that your account is synced in Apple Calendar. Managed calendars may be unavailable to other apps.")
                            .foregroundStyle(.secondary)
                    }
                }

                if !store.selectedIDs.isEmpty { agenda }
                else if !store.calendars.isEmpty {
                    Section {
                        Text("Choose a calendar to see its events here.")
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if store.isEnabled {
                Section {
                    Button("Stop using iPhone calendars", role: .destructive) { confirmingDisconnect = true }
                } footer: {
                    Text("Clears your selection and displayed events. You can also revoke calendar access in iPhone Settings.")
                }
            }
        }
        .navigationTitle("iPhone calendars")
        .assistantSubmenuChrome()
        .refreshable {
            if scenePhase == .active && isVisible { store.refresh() }
        }
        .task {
            isVisible = true
            if scenePhase == .active { store.refresh() }
        }
        .onChange(of: store.day) { _, _ in
            if scenePhase == .active && isVisible { store.refresh() }
        }
        .onChange(of: store.isEnabled) { _, enabled in
            if enabled && store.selectedIDs.isEmpty && !store.calendars.isEmpty { choosingCalendars = true }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active && isVisible { store.refresh() }
            else {
                choosingCalendars = false
                store.clearVisibleEvents()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .EKEventStoreChanged)) { _ in
            if scenePhase == .active && isVisible { store.refresh() }
        }
        .onDisappear {
            isVisible = false
            store.clearVisibleEvents()
        }
        .sheet(isPresented: $choosingCalendars) {
            NavigationStack { PhoneCalendarSelectionView(store: store) }
        }
        .confirmationDialog("Stop using iPhone calendars?", isPresented: $confirmingDisconnect, titleVisibility: .visible) {
            Button("Stop using calendars", role: .destructive) { store.disable() }
        } message: {
            Text("Your selection and displayed events will be cleared. Your Apple Calendar events won’t be changed.")
        }
    }

    private var agenda: some View {
        Group {
            Section {
                DatePicker("Day", selection: $store.day, displayedComponents: .date)
                HStack {
                    Button("Previous day", systemImage: "chevron.left") { moveDay(-1) }
                        .labelStyle(.iconOnly)
                    Spacer()
                    Button("Today") { store.day = Date() }
                    Spacer()
                    Button("Next day", systemImage: "chevron.right") { moveDay(1) }
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.borderless)
            }
            Section {
                if store.events.isEmpty {
                    Text("No events in your selected calendars on this day.").foregroundStyle(.secondary)
                } else {
                    ForEach(store.events) { event in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(event.title).font(.headline)
                            if event.isAllDay { Text("All day").font(.subheadline) }
                            else {
                                Text(event.start..<event.end, format: .interval.day().month().hour().minute())
                                    .font(.subheadline)
                            }
                            if let location = event.location {
                                Label(location, systemImage: "mappin.and.ellipse").font(.subheadline)
                            }
                            if let calendar = store.calendars.first(where: { $0.id == event.calendarID }) {
                                Text("\(calendar.title) · \(calendar.account)")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                        .accessibilityElement(children: .combine)
                    }
                }
            } header: {
                Text(store.day, format: .dateTime.weekday(.wide).month().day())
            } footer: {
                Text("Showing the events currently synced to this iPhone. Open Apple Calendar to check account sync if something is missing.")
            }
        }
    }

    private func moveDay(_ value: Int) {
        if let day = Calendar.autoupdatingCurrent.date(byAdding: .day, value: value, to: store.day) { store.day = day }
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
    }
}

private struct PhoneCalendarSelectionView: View {
    let store: PhoneCalendarStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        AssistantSettingsList {
            Section {
                ForEach(store.calendars) { calendar in
                    Toggle(isOn: Binding(
                        get: { store.selectedIDs.contains(calendar.id) },
                        set: { store.select(calendar, enabled: $0) }
                    )) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(calendar.title)
                            Text(calendar.account).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            } footer: {
                Text("Only selected calendars are displayed. Nothing is sent to your assistant server.")
            }
        }
        .navigationTitle("Choose calendars")
        .assistantSubmenuChrome()
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
}
