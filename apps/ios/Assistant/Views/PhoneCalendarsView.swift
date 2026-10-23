import EventKit
import SwiftUI

@MainActor
struct PhoneCalendarsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var store: PhoneCalendarStore
    @State private var choosingCalendars = false
    @State private var confirmingDisconnect = false
    @State private var confirmingShareRemoval = false
    @State private var confirmingShareReplacement = false
    @State private var reviewSharing = false
    @State private var shareCalendarIDs = Set<String>()
    @State private var sharePurposes: [String: PhoneCalendarPurpose] = [:]
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
                Text("These choices only control what appears on this iPhone. Sharing with your assistant server is a separate opt-in below.")
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
                    Button("Stop local calendar display", role: .destructive) { confirmingDisconnect = true }
                } footer: {
                    Text("Clears the local display selection and events. This does not change separate assistant-server sharing. You can also revoke calendar access in iPhone Settings.")
                }
            }
            sharingSection
        }
        .navigationTitle("iPhone calendars")
        .assistantSubmenuChrome()
        .refreshable {
            if scenePhase == .active && isVisible {
                store.refresh()
                await model.refreshPhoneCalendarSharingSnapshot()
            }
        }
        .task {
            isVisible = true
            if scenePhase == .active { store.refresh() }
            await model.loadPhoneCalendarSharing()
            if let state = model.phoneCalendarSharing.serverState, state.enabled,
               state.publisherId == model.phoneCalendarSharing.localPublisherID {
                shareCalendarIDs = Set(state.calendars.map(\.id))
                sharePurposes = Dictionary(uniqueKeysWithValues: state.calendars.map { ($0.id, $0.purpose) })
            }
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
        .onReceive(NotificationCenter.default.publisher(for: .EKEventStoreChanged).receive(on: RunLoop.main)) { _ in
            if scenePhase == .active && isVisible { store.refresh() }
        }
        .onDisappear {
            isVisible = false
            store.clearVisibleEvents()
        }
        .sheet(isPresented: $choosingCalendars) {
            NavigationStack { PhoneCalendarSelectionView(store: store) }
        }
        .confirmationDialog("Stop local calendar display?", isPresented: $confirmingDisconnect, titleVisibility: .visible) {
            Button("Stop using calendars", role: .destructive) { store.disable() }
        } message: {
            Text("Your local display selection and events will be cleared. Assistant-server sharing is managed separately below. Your Apple Calendar events won’t be changed.")
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

    private var sharingSection: some View {
        Section {
            Text("Calendar sharing starts off. When enabled, selected event titles, times, locations and event IDs are sent to your assistant server for the 7 days before today through 45 days ahead, using the owner time zone. Selected calendar names and IDs and each source’s availability are also shared. A matching invitation email and response status may be included when iPhone Calendar identifies your account. A calendar’s purpose describes its use; it does not show whether you accepted an invitation.")
                .font(.footnote).foregroundStyle(.secondary)

            Text("The snapshot is considered current only when the capture and server receipt are both within 30 minutes and the full date window is covered. Snapshots are retained for up to 7 days. Assistant syncs while the app is open, after calendar changes, before calendar questions, and when you choose Sync now; it does not promise background calendar sync.")
                .font(.footnote).foregroundStyle(.secondary)

            Text(sharingWindowDescription)
                .font(.footnote).foregroundStyle(.secondary)
            Text("Notes and full guest lists aren’t shared. Earlier chat messages may still contain details from a calendar answer after sharing is stopped.")
                .font(.footnote).foregroundStyle(.secondary)

            if let owner = model.phoneCalendarSharing.ownerEmail, model.phoneCalendarSharing.isOwnerVerified {
                Label("Assistant account: \(owner)", systemImage: "checkmark.shield")
                    .font(.subheadline).foregroundStyle(.secondary)
            } else if model.bootstrap == nil {
                Text("Connect to your assistant server before setting up sharing.")
                    .foregroundStyle(.secondary)
            } else {
                Button("Check sharing with assistant server") {
                    Task { await model.loadPhoneCalendarSharing() }
                }
                .disabled(model.phoneCalendarSharing.isWorking)
            }

            if model.phoneCalendarSharing.hasPendingRevocation {
                Label("Removal is queued until this account reconnects.", systemImage: "clock.arrow.circlepath")
                    .foregroundStyle(.secondary)
            }
            if let message = model.phoneCalendarSharing.statusMessage {
                Text(message).font(.footnote).foregroundStyle(.secondary)
            }
            if let error = model.phoneCalendarSharing.errorMessage {
                Text(error).font(.footnote).foregroundStyle(.secondary)
            }

            if model.phoneCalendarSharing.canStopSharing, let state = model.phoneCalendarSharing.serverState, state.enabled {
                Label(model.phoneCalendarSharing.isSharingEnabled
                      ? "Sharing setup is on · \(state.calendars.count) calendars"
                      : "Sharing is paused · \(state.calendars.count) calendars",
                      systemImage: model.phoneCalendarSharing.isSharingEnabled ? "arrow.up.to.line" : "pause.circle")
                Text(snapshotStatus(for: state)).font(.footnote).foregroundStyle(.secondary)
                if let received = formattedReceipt(state.receivedAt) {
                    Text("Last received by server: \(received)").font(.footnote).foregroundStyle(.secondary)
                }
                if let captured = formattedReceipt(state.capturedAt) {
                    Text("Captured on this iPhone: \(captured)").font(.footnote).foregroundStyle(.secondary)
                }
                if let window = actualSnapshotWindow(state) {
                    Text(window).font(.footnote).foregroundStyle(.secondary)
                }
                Button("Sync now") { Task { await model.refreshPhoneCalendarSharingSnapshot() } }
                    .disabled(model.phoneCalendarSharing.isWorking || model.phoneCalendarSharing.requiresPermissionReview)
                Button("Review shared calendars") { reviewSharedCalendars() }
            }
            if model.phoneCalendarSharing.requiresReplace {
                Label("Calendar sharing is active from another iPhone or an earlier installation. This installation is not uploading.", systemImage: "iphone.gen3")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("Check status") { Task { await model.loadPhoneCalendarSharing() } }
                    .disabled(model.phoneCalendarSharing.isWorking)
            }
            if model.phoneCalendarSharing.requiresPermissionReview {
                Label("Uploads are paused. Review the selected calendars and confirm sharing before uploads resume.", systemImage: "pause.circle")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if model.phoneCalendarSharing.canStopSharing {
                Button("Stop sharing calendars", role: .destructive) { confirmingShareRemoval = true }
                    .confirmationDialog("Stop sharing calendars?", isPresented: $confirmingShareRemoval, titleVisibility: .visible) {
                        Button("Stop sharing", role: .destructive) { Task { await model.stopPhoneCalendarSharing() } }
                    } message: {
                        Text("This iPhone stops uploading immediately. If offline, removal stays queued; the server deletes its saved snapshot only after it confirms the request. Earlier chat messages remain.")
                    }
            }

            if reviewSharing || !model.phoneCalendarSharing.isSharingEnabled {
                if model.phoneCalendarSharing.access != .fullAccess {
                    Button {
                        Task { await model.phoneCalendarSharing.requestCalendarAccess() }
                    } label: {
                        if model.phoneCalendarSharing.isWorking { ProgressView("Requesting access") }
                        else { Label("Choose calendars to share", systemImage: "calendar.badge.plus") }
                    }
                    .disabled(model.phoneCalendarSharing.isWorking || model.phoneCalendarSharing.hasPendingRemoval || !model.phoneCalendarSharing.isOwnerVerified)
                    if model.phoneCalendarSharing.access == .denied || model.phoneCalendarSharing.access == .restricted || model.phoneCalendarSharing.access == .writeOnly {
                        Text("Full Calendar Access is required. You can change it in iPhone Settings.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                } else {
                    ForEach(model.phoneCalendarSharing.calendars) { calendar in
                        VStack(alignment: .leading, spacing: 8) {
                            Toggle(isOn: Binding(
                                get: { shareCalendarIDs.contains(calendar.id) },
                                set: { enabled in
                                    if enabled { shareCalendarIDs.insert(calendar.id) }
                                    else { shareCalendarIDs.remove(calendar.id) }
                                }
                            )) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(calendar.title)
                                    Text(calendar.account).font(.caption).foregroundStyle(.secondary)
                                    Text("\(calendar.id) · Available on this iPhone")
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                            if shareCalendarIDs.contains(calendar.id) {
                                Picker("Purpose", selection: Binding(
                                    get: { sharePurposes[calendar.id] ?? .unspecified },
                                    set: { sharePurposes[calendar.id] = $0 }
                                )) {
                                    ForEach(PhoneCalendarPurpose.allCases) { purpose in
                                        Text(purpose.title).tag(purpose)
                                    }
                                }
                                .accessibilityLabel("Sharing purpose for \(calendar.title)")
                            }
                        }
                    }
                }
                ForEach(selectedMissingCalendars) { calendar in
                    VStack(alignment: .leading, spacing: 8) {
                        Toggle(isOn: Binding(
                            get: { shareCalendarIDs.contains(calendar.id) },
                            set: { enabled in
                                if enabled { shareCalendarIDs.insert(calendar.id) }
                                else { shareCalendarIDs.remove(calendar.id) }
                            }
                        )) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(calendar.name)
                                Text("\(calendar.id) · No longer available on this iPhone")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        if shareCalendarIDs.contains(calendar.id) {
                            Picker("Purpose", selection: Binding(
                                get: { sharePurposes[calendar.id] ?? calendar.purpose },
                                set: { sharePurposes[calendar.id] = $0 }
                            )) {
                                ForEach(PhoneCalendarPurpose.allCases) { purpose in
                                    Text(purpose.title).tag(purpose)
                                }
                            }
                            .accessibilityLabel("Sharing purpose for \(calendar.name)")
                        }
                    }
                }
                if !shareCalendarIDs.isEmpty && model.phoneCalendarSharing.isOwnerVerified {
                    let replace = model.phoneCalendarSharing.requiresReplace
                    Button(replace ? "Review and replace calendar sharing" : model.phoneCalendarSharing.requiresPermissionReview ? "Review and resume sharing" : model.phoneCalendarSharing.isSharingEnabled ? "Update shared calendars" : "Turn on calendar sharing") {
                        if replace { confirmingShareReplacement = true }
                        else { submitSharedCalendarSelection(replace: false) }
                    }
                    .disabled(model.phoneCalendarSharing.isWorking || model.phoneCalendarSharing.hasPendingRemoval)
                    .confirmationDialog("Replace calendar sharing from another iPhone or installation?", isPresented: $confirmingShareReplacement, titleVisibility: .visible) {
                        Button("Replace and upload from this iPhone", role: .destructive) {
                            submitSharedCalendarSelection(replace: true)
                        }
                    } message: {
                        Text("This switches the shared calendar source to this iPhone. Review the selected calendars and purposes first. The other iPhone’s snapshots will no longer be accepted.")
                    }
                }
            }
        } header: {
            Text("Share with your assistant")
        } footer: {
            Text("Only the calendars you check are queried. Calendar IDs and availability are shown so you can review the sources. Stopping sharing turns off new uploads immediately; the server snapshot is removed after it confirms the request. Earlier chat messages remain.")
        }
    }

    private func reviewSharedCalendars() {
        guard let state = model.phoneCalendarSharing.serverState,
              state.publisherId == model.phoneCalendarSharing.localPublisherID else { return }
        shareCalendarIDs = Set(state.calendars.map(\.id))
        sharePurposes = Dictionary(uniqueKeysWithValues: state.calendars.map { ($0.id, $0.purpose) })
        reviewSharing = true
        Task { await model.phoneCalendarSharing.requestCalendarAccess() }
    }

    private var selectedMissingCalendars: [SharedPhoneCalendar] {
        guard let state = model.phoneCalendarSharing.serverState,
              state.publisherId == model.phoneCalendarSharing.localPublisherID else { return [] }
        let available = Set(model.phoneCalendarSharing.calendars.map(\.id))
        return state.calendars.filter { shareCalendarIDs.contains($0.id) && !available.contains($0.id) }
    }

    private func submitSharedCalendarSelection(replace: Bool) {
        let available = model.phoneCalendarSharing.calendars.filter { shareCalendarIDs.contains($0.id) }.map { calendar in
            SharedPhoneCalendar(id: calendar.id, name: calendar.title,
                                purpose: sharePurposes[calendar.id] ?? .unspecified,
                                timeZone: calendar.timeZoneIdentifier)
        }
        let retained = selectedMissingCalendars.map { previous in
            SharedPhoneCalendar(id: previous.id, name: previous.name,
                                purpose: sharePurposes[previous.id] ?? previous.purpose,
                                timeZone: previous.timeZone)
        }
        Task { await model.startPhoneCalendarSharing(with: available + retained, replace: replace) }
    }

    private func actualSnapshotWindow(_ state: PhoneCalendarSharingState) -> String? {
        PhoneCalendarSnapshotWindowFormatter.format(
            timeMin: state.timeMin,
            timeMax: state.timeMax,
            ownerTimeZone: model.phoneCalendarSharing.ownerTimeZone
        )
    }

    private var sharingWindowDescription: String {
        guard let zoneID = model.phoneCalendarSharing.ownerTimeZone,
              let zone = TimeZone(identifier: zoneID) else {
            return "Before sharing starts, Assistant will show the exact 7-days-back through 45-days-ahead date window in your assistant account’s time zone."
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let today = calendar.startOfDay(for: Date())
        guard let first = calendar.date(byAdding: .day, value: -7, to: today),
              let last = calendar.date(byAdding: .day, value: 45, to: today) else { return "Sharing uses the owner time zone (\(zoneID))." }
        let formatter = DateFormatter()
        formatter.locale = Locale.current
        formatter.timeZone = zone
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return "Review window in \(zoneID): \(formatter.string(from: first)) through \(formatter.string(from: last))."
    }

    private func snapshotStatus(for state: PhoneCalendarSharingState) -> String {
        switch PhoneCalendarSnapshotFreshness.evaluate(state, ownerTimeZone: model.phoneCalendarSharing.ownerTimeZone ?? "") {
        case .notSent:
            "Setup is confirmed, but the server hasn’t received a calendar snapshot yet."
        case .stale:
            "The saved snapshot is older than 30 minutes. Sync to refresh the selected date window."
        case .incomplete:
            "The latest snapshot is incomplete or doesn’t cover the full selected date window. Review calendar access, then sync again."
        case .current:
            "The server received a complete snapshot for the full selected date window within the last 30 minutes."
        }
    }

    private func formattedReceipt(_ value: String?) -> String? {
        guard let value else { return nil }
        let parser = ISO8601DateFormatter()
        let date = parser.date(from: value) ?? {
            parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return parser.date(from: value)
        }()
        guard let date else { return value }
        return date.formatted(date: .abbreviated, time: .shortened)
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
                Text("Only selected calendars are displayed here. Assistant-server sharing is managed separately.")
            }
        }
        .navigationTitle("Choose calendars")
        .assistantSubmenuChrome()
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
}
