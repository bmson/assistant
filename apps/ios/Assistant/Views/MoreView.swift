import SwiftUI

struct MoreView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject private var notifications = NotificationManager.shared
    @AppStorage(AssistantAppearance.defaultsKey) private var appearance = AssistantAppearance.dark
    @AppStorage(AppModel.shareLocationKey) private var shareLocation = false
    @AppStorage(AppModel.shareLocationBackgroundKey) private var shareLocationBackground = false
    @AppStorage(SpeechSettings.speakRepliesKey) private var speakReplies = false
    @AppStorage(SpeechSettings.paceKey) private var speechPace = SpeechPace.default
    @AppStorage(SpeechSettings.voiceKey) private var speechVoice = ""
    @ObservedObject private var locations = LocationManager.shared
    @State private var showingAgentSettings = false
    @State private var showingTalk = false
    @State private var settingsActionInFlight: String?
    @State private var policyPendingDeletion: WorkspacePolicy?
    @State private var isLoadingSettings = false
    @State private var settingsLoadFailed = false
    @State private var settingsActionFailed = false
    /// The voices installed for this language, best first. Read once the screen
    /// appears rather than on every redraw — the answer only changes when the
    /// owner leaves for Settings and downloads one.
    @State private var voiceChoices: [SpeechVoices.Candidate] = []

    var body: some View {
        AssistantSettingsList {
            Section {
                Button { showingAgentSettings = true } label: { assistantIdentity }
                .disabled(model.workspace == nil || isLoadingSettings || settingsLoadFailed)
                .accessibilityLabel("Edit preferences for \(model.agentName)")
                .accessibilityHint("Language, time zone, and email signature")
            }

            if settingsLoadFailed {
                AssistantLoadFailureState(
                    title: "Couldn’t refresh assistant settings",
                    message: model.workspace == nil ? "Try again to load your preferences and rules." : "Your previous settings are shown. Refresh before changing them.",
                    retry: { Task { await reloadSettings() } }
                )
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            } else if model.workspace == nil {
                Section { ProgressView("Loading assistant settings") }
            }
            if settingsActionFailed {
                Section {
                    AssistantInlineFailure(message: "Couldn’t confirm that change. Try again or pull to refresh your settings.")
                }
            }

            Section {
                notificationRow
                NavigationLink {
                    RemindersView()
                } label: {
                    HStack {
                        Label("Reminders", systemImage: "bell.and.waves.left.and.right")
                        Spacer(minLength: 12)
                        if let count = model.workspace?.settings.reminders.count, count > 0 {
                            Text("\(count)")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                Text("Notifications")
            } footer: {
                Text("Get an alert when background work finishes or needs a decision. Notification previews stay private.")
            }

            Section {
                if dynamicTypeSize.isAccessibilitySize {
                    appearancePicker.pickerStyle(.menu)
                } else {
                    appearancePicker.pickerStyle(.segmented)
                }
            } header: {
                Text("Appearance")
            } footer: {
                Text("Dark keeps the conversation stage day and night. System follows this iPhone’s appearance setting.")
            }

            Section {
                Button("Talk to the assistant", systemImage: "waveform") { showingTalk = true }
                    .disabled(model.isSending)
                    .accessibilityHint("Starts a hands-free conversation. You can interrupt the assistant while it speaks.")
                Toggle("Speak replies aloud", isOn: $speakReplies)
                speechPacePicker
                if voiceChoices.count > 1 {
                    speechVoicePicker
                }
                if let best = voiceChoices.first, !best.isNatural {
                    voiceQualityHint
                }
            } header: {
                Text("Speech")
            } footer: {
                Text("Speak replies aloud reads new replies through the speaker, even with the ringer off. Long-press a reply to hear it once.")
            }

            Section("Services") {
                NavigationLink {
                    ConnectionView(isOnboarding: false)
                } label: {
                    Label("Assistant server", systemImage: "network")
                }
                NavigationLink {
                    AIProvidersView()
                } label: {
                    Label("AI providers", systemImage: "cpu")
                }
                NavigationLink {
                    CallsView()
                } label: {
                    Label("Calls", systemImage: "phone")
                }
                NavigationLink {
                    MCPConnectionsView()
                } label: {
                    Label("Connected tools", systemImage: "point.3.connected.trianglepath.dotted")
                }
            }

            if let conversation = model.activeConversation ?? model.bootstrap?.conversation,
               !conversation.models.isEmpty {
                Section("Current chat") {
                    Picker(
                        "Model",
                        selection: Binding(
                            get: { conversation.conversation.modelOverride ?? "" },
                            set: { value in
                                guard !model.isSending else { return }
                                performSettingsAction("chat-model", requiresWorkspace: false) {
                                    await model.changeConversationModel(value.isEmpty ? nil : value)
                                }
                            }
                        )
                    ) {
                        Text("Automatic").tag("")
                        ForEach(conversation.models) { option in
                            Text(option.label).tag(option.id)
                        }
                    }
                    .disabled(settingsActionInFlight != nil || model.isSending)
                    .accessibilityHint(model.isSending ? "Finish or stop the current reply before changing its model." : "")
                    if model.isSending {
                        Text("Finish or stop the current reply before changing its model.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section {
                Toggle(isOn: $shareLocation) {
                    Label("Share iPhone location", systemImage: "location")
                }
                // Turning the intent on is what triggers the permission prompt
                // — never the app launch.
                .onChange(of: shareLocation) { _, on in
                    if on {
                        locations.requestAccess()
                        Task { await model.shareLocationIfEnabled(force: true) }
                    } else {
                        shareLocationBackground = false
                        locations.setBackgroundMonitoring(false)
                    }
                }
                if shareLocation && locations.accessDenied {
                    Button {
                        locations.openSystemSettings()
                    } label: {
                        Label("Location access is off — open Settings", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(AssistantTheme.warningInk(for: colorScheme))
                    }
                }
                Toggle(isOn: $shareLocationBackground) {
                    Label("Background arrival nudges", systemImage: "mappin.and.ellipse")
                }
                .disabled(!shareLocation)
                .onChange(of: shareLocationBackground) { _, on in
                    locations.setBackgroundMonitoring(on)
                }
                if shareLocationBackground && !locations.hasAlwaysAccess {
                    Text("iOS will ask for Always location access; until then, arrivals are noticed only while the app is open.")
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                }
            } header: {
                Text("Assistant context")
            } footer: {
                Text("Share your current location with your own server for nearby answers. Arrival nudges use coarse location changes. You can turn either setting off at any time.")
            }

            // The lower-traffic work areas. The pull-up menu stays at eight
            // primary destinations; these open from here instead.
            Section("Workspace") {
                NavigationLink {
                    WorkspaceView(area: .capabilities)
                } label: {
                    Label("Capabilities", systemImage: "puzzlepiece.extension")
                }
                NavigationLink {
                    WorkspaceView(area: .documents)
                } label: {
                    Label("Documents", systemImage: "doc.text")
                }
                NavigationLink {
                    WorkspaceView(area: .skills)
                } label: {
                    Label("Skills", systemImage: "lightbulb")
                }
                NavigationLink {
                    WorkspaceView(area: .costs)
                } label: {
                    Label("Costs", systemImage: "dollarsign.circle")
                }
                NavigationLink {
                    WorkspaceView(area: .anomalies)
                } label: {
                    Label("Anomalies", systemImage: "exclamationmark.triangle")
                }
                NavigationLink {
                    WorkspaceView(area: .improvements)
                } label: {
                    Label("Improvements", systemImage: "arrow.triangle.2.circlepath")
                }
            }

            if let settings = model.workspace?.settings {
                Section("Recurring jobs") {
                    if settings.schedules.isEmpty {
                        Label("No recurring jobs", systemImage: "clock")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(settings.schedules) { schedule in
                            scheduleRow(schedule)
                        }
                    }
                    if settings.goalAutomationCount > 0 {
                        Label(
                            "\(settings.goalAutomationCount) goal \(settings.goalAutomationCount == 1 ? "automation" : "automations") managed from Goals",
                            systemImage: "scope"
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                }

                Section {
                    if settings.policies.isEmpty {
                        Label("No standing rules", systemImage: "checkmark.shield")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(settings.policies) { policy in
                            policyRow(policy)
                        }
                    }
                } header: {
                    Text("Standing approvals")
                } footer: {
                    Text("Enabled rules let the assistant take these actions without asking each time.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle("More")
        .assistantSubmenuChrome()
        .toolbarBackground(.visible, for: .navigationBar)
        .refreshable { await reloadSettings() }
        .task {
            refreshVoiceChoices()
            await notifications.refreshAuthorizationStatus()
            if model.workspace == nil { await reloadSettings() }
        }
        // Downloading a voice happens in Settings, not here. Coming back to
        // this screen is the moment to notice that one arrived.
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            refreshVoiceChoices()
            SpeechPlayer.shared.voicePreferenceChanged()
            Task { await notifications.refreshAuthorizationStatus() }
        }
        .confirmationDialog(
            "Delete standing approval?",
            isPresented: Binding(
                get: { policyPendingDeletion != nil },
                set: { if !$0 { policyPendingDeletion = nil } }
            ),
            titleVisibility: .visible,
            presenting: policyPendingDeletion
        ) { policy in
            Button("Delete rule", role: .destructive) {
                performSettingsAction(policy.id) { await model.deletePolicy(policy) }
            }
        } message: { policy in
            Text("This removes “\(policy.displayName)”.")
        }
        .sheet(isPresented: $showingAgentSettings) {
            if let settings = model.workspace?.settings.agent {
                NavigationStack { AgentSettingsEditor(settings: settings) }
            }
        }
        .fullScreenCover(isPresented: $showingTalk) { TalkView() }
    }

    private func reloadSettings() async {
        guard !isLoadingSettings, settingsActionInFlight == nil else { return }
        isLoadingSettings = true
        let refreshed = await model.refreshWorkspace()
        isLoadingSettings = false
        guard !Task.isCancelled else { return }
        settingsLoadFailed = !refreshed
    }

    private func performSettingsAction(_ id: String, requiresWorkspace: Bool = true, action: @escaping () async -> Bool) {
        guard settingsActionInFlight == nil, !(requiresWorkspace && (settingsLoadFailed || isLoadingSettings)) else { return }
        settingsActionFailed = false
        settingsActionInFlight = id
        Task {
            settingsActionFailed = !(await action())
            settingsActionInFlight = nil
        }
    }

    /// A voice the owner picked can be deleted from Settings while the choice
    /// is still stored here. Fall back to "best installed" rather than showing
    /// a picker with nothing selected.
    private func refreshVoiceChoices() {
        voiceChoices = SpeechVoices.choices()
        if !speechVoice.isEmpty, !voiceChoices.contains(where: { $0.identifier == speechVoice }) {
            speechVoice = ""
        }
    }

    private var appearancePicker: some View {
        Picker("Appearance", selection: $appearance) {
            ForEach(AssistantAppearance.allCases) { option in
                Text(option.label).tag(option)
            }
        }
    }

    /// Segments are quick at ordinary sizes. A native menu keeps every label
    /// and the current value readable when the owner enlarges text.
    private var speechPacePicker: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                pacePicker.pickerStyle(.menu)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Speed")
                    pacePicker.pickerStyle(.segmented).labelsHidden()
                }
                .padding(.vertical, 2)
            }
        }
        .onChange(of: speechPace) { _, _ in SpeechPlayer.shared.preview() }
    }

    private var pacePicker: some View {
        Picker("Speed", selection: $speechPace) {
            ForEach(SpeechPace.allCases) { pace in Text(pace.label).tag(pace) }
        }
    }

    /// Which of the installed voices to use. "Best installed" is the default
    /// and stays right as voices are added, but a phone with two natural
    /// voices on it has a preference worth having.
    private var speechVoicePicker: some View {
        Picker("Voice", selection: $speechVoice) {
            Text("Best installed").tag("")
            ForEach(voiceChoices, id: \.identifier) { voice in
                Text("\(voice.name) · \(voice.qualityLabel)").tag(voice.identifier)
            }
        }
        .onChange(of: speechVoice) { _, _ in
            SpeechPlayer.shared.voicePreferenceChanged()
            SpeechPlayer.shared.preview()
        }
    }

    /// The good voices are neural, and an app cannot fetch them — only the
    /// owner can, from Settings. Say so once, here, rather than letting anyone
    /// conclude the assistant simply sounds like this.
    private var voiceQualityHint: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label("Only the compact voice is installed", systemImage: "waveform")
            Text("Settings › Accessibility › Spoken Content › Voices has the natural ones. Download one for your language and the assistant will use it automatically.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var notificationRow: some View {
        switch notifications.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            Button {
                notifications.openSystemSettings()
            } label: {
                notificationStatusLabel(title: "Assistant notifications", value: "On", icon: "bell.badge.fill")
            }
        case .denied:
            Button {
                notifications.openSystemSettings()
            } label: {
                notificationStatusLabel(title: "Assistant notifications", value: "Off", icon: "bell.slash")
            }
        case .notDetermined:
            VStack(alignment: .leading, spacing: 7) {
                Button {
                    Task { await notifications.requestAuthorization() }
                } label: {
                    if notifications.isRequestingAuthorization {
                        Label("Turning on notifications", systemImage: "bell.badge")
                    } else {
                        Label("Turn on notifications", systemImage: "bell.badge")
                    }
                }
                .disabled(notifications.isRequestingAuthorization)

                if let error = notifications.authorizationError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(AssistantTheme.errorInk(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        @unknown default:
            EmptyView()
        }
    }

    private func notificationStatusLabel(title: String, value: String, icon: String) -> some View {
        HStack {
            Label(title, systemImage: icon)
            Spacer(minLength: 12)
            Text(value)
                .foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(value)")
        .accessibilityHint("Opens iOS notification settings")
    }

    @ViewBuilder
    private var assistantIdentity: some View {
        HStack(spacing: 12) {
            AssistantGlyph(systemName: "slider.horizontal.3", tint: AssistantTheme.accent(for: colorScheme))
            VStack(alignment: .leading, spacing: 4) {
                Text(model.agentName)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Language, time zone, and signature")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
        }
    }

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }

    // Labels arrive with the payload from the server's own dictionaries, so
    // the phone and the web dashboard describe the same job the same way.
    @ViewBuilder
    private func scheduleRow(_ schedule: WorkspaceSchedule) -> some View {
        let detail = VStack(alignment: .leading, spacing: 3) {
            Text(schedule.displayName)
            Text(
                schedule.enabled
                    ? schedule.nextRunAt.map { "Next \(relative($0))" } ?? "Preparing next run"
                    : "Paused"
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        Toggle(
            isOn: Binding(
                get: { schedule.enabled },
                set: { enabled in
                    performSettingsAction(schedule.id) { await model.setSchedule(schedule, enabled: enabled) }
                }
            )
        ) { detail }
        .disabled(settingsActionInFlight != nil || isLoadingSettings || settingsLoadFailed)
    }

    @ViewBuilder
    private func policyRow(_ policy: WorkspacePolicy) -> some View {
        let detail = VStack(alignment: .leading, spacing: 4) {
            Text(policy.displayName)
                .fixedSize(horizontal: false, vertical: true)
            Text(policy.scope ?? policy.toolName.sentenceCaseIdentifier)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }

        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 8) {
                detail
                HStack(spacing: 8) {
                    policyToggle(policy) { Text("Allow automatically") }
                    policyActions(policy)
                }
            }
        } else {
            HStack(alignment: .center, spacing: 8) {
                policyToggle(policy) { detail }
                policyActions(policy)
            }
        }
    }

    private func policyToggle<Label: View>(
        _ policy: WorkspacePolicy,
        @ViewBuilder label: () -> Label
    ) -> some View {
        Toggle(isOn: Binding(
            get: { policy.enabled },
            set: { enabled in
                performSettingsAction(policy.id) { await model.setPolicy(policy, enabled: enabled) }
            }
        ), label: label)
        .accessibilityLabel(policy.displayName)
        .accessibilityHint(policy.scope ?? policy.toolName.sentenceCaseIdentifier)
        .disabled(settingsActionInFlight != nil || isLoadingSettings || settingsLoadFailed)
    }

    private func policyActions(_ policy: WorkspacePolicy) -> some View {
        Menu {
            Button("Delete rule", systemImage: "trash", role: .destructive) {
                policyPendingDeletion = policy
            }
        } label: {
            AssistantActionMenuLabel(isUpdating: settingsActionInFlight == policy.id)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Actions for \(policy.displayName)")
        .disabled(settingsActionInFlight != nil || isLoadingSettings || settingsLoadFailed)
    }

}

private struct RemindersView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var removalInFlight: String?
    @State private var isLoading = false
    @State private var loadFailed = false
    @State private var removalFailed = false

    private var reminders: [WorkspaceReminder] {
        model.workspace?.settings.reminders ?? []
    }

    var body: some View {
        AssistantSettingsList {
            if loadFailed {
                AssistantLoadFailureState(
                    title: "Couldn’t refresh reminders",
                    message: model.workspace == nil ? "Try again to check your active reminders." : "Previous reminders are shown. Refresh before removing one.",
                    retry: { Task { await load() } }
                )
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
            if removalFailed {
                Section { AssistantInlineFailure(message: "Couldn’t confirm removal. Refresh to check whether the reminder is still active.") }
            }
            if model.workspace == nil && !loadFailed {
                Section { ProgressView("Loading reminders") }
            } else if reminders.isEmpty && !loadFailed {
                AssistantEmptyState(
                    "No active reminders",
                    systemImage: "bell.slash",
                    description: "Ask in chat to be reminded once, daily, or on selected days."
                )
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            } else if !reminders.isEmpty {
                Section {
                    ForEach(reminders) { reminder in
                        reminderRow(reminder)

                    }
                } footer: {
                    Text("Removing a reminder stops queued and future alerts. Earlier chat messages stay in the conversation.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle("Reminders")
        .assistantSubmenuChrome()
        .refreshable { await load() }
        // Reminders are often created in Chat immediately before this route is
        // opened. Always refresh on appearance so the projection reflects the
        // server mutation rather than the last workspace snapshot.
        .task { await load() }

    }

    private func reminderRow(_ reminder: WorkspaceReminder) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            AssistantGlyph(
                systemName: reminder.repeats ? "repeat" : "bell",
                tint: AssistantTheme.accent(for: colorScheme)
            )
            VStack(alignment: .leading, spacing: 5) {
                Text(reminder.text)
                    .font(.body.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
                Text(reminderDetail(reminder))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            // Trailing-aligned to match the standing-approvals row: a
            // compact secondary action rather than a left-hugging control
            // stranded under the full row width.
            AssistantConfirmationButton("Remove", hint: "Stops queued and future reminder alerts.", compact: true) {
                guard removalInFlight == nil, !isLoading, !loadFailed else { return }
                removalInFlight = reminder.id
                removalFailed = !(await model.deleteReminder(reminder))
                removalInFlight = nil
            }
            .disabled(removalInFlight != nil || isLoading || loadFailed)
            .accessibilityLabel("Remove reminder: \(reminder.text)")
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(.vertical, 4)
    }

    private func load() async {
        guard !isLoading, removalInFlight == nil else { return }
        isLoading = true
        let refreshed = await model.refreshWorkspace()
        isLoading = false
        guard !Task.isCancelled else { return }
        loadFailed = !refreshed
        if refreshed { removalFailed = false }
    }

    private func reminderDetail(_ reminder: WorkspaceReminder) -> String {
        if reminder.isDelivering { return "Delivering now · \(reminder.repeats ? "Repeats" : "Once")" }
        let cadence = reminder.repeats ? "Repeats" : "Once"
        guard let nextRunAt = reminder.nextRunAt else { return cadence }
        return "\(cadence) · Next \(relative(nextRunAt))"
    }
}

private struct AgentSettingsEditor: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var timezone: String
    @State private var locale: String
    @State private var signature: String
    @State private var isSaving = false
    @State private var saveFailed = false

    init(settings: WorkspaceAgentSettings) {
        _timezone = State(initialValue: settings.timezone)
        _locale = State(initialValue: settings.locale)
        _signature = State(initialValue: settings.signature)
    }

    var body: some View {
        AssistantForm {
            Section("Language and time") {
                AssistantField("Time zone") {
                    TextField("Time zone", text: $timezone)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                AssistantField("Language and region") {
                    TextField("Language and region", text: $locale)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Button("Use this iPhone’s settings", systemImage: "iphone") {
                    timezone = TimeZone.current.identifier
                    locale = Locale.current.identifier(.bcp47)
                }
            }
            Section("Signature") {
                TextField("Email signature", text: $signature, axis: .vertical)
                    .lineLimit(2...6)
            }
            if saveFailed {
                Section { AssistantInlineFailure(message: "Couldn’t save your preferences. Your entries are kept; try again.") }
            }
        }
        .disabled(isSaving)
        .navigationTitle("Assistant settings")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(isSaving)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }.disabled(isSaving)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") { save() }
                    .disabled(isSaving || timezone.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || locale.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private func save() {
        guard !isSaving else { return }
        isSaving = true
        saveFailed = false
        Task {
            let saved = await model.updateAgentSettings(
                .init(timezone: timezone.trimmingCharacters(in: .whitespacesAndNewlines), locale: locale.trimmingCharacters(in: .whitespacesAndNewlines), signature: signature)
            )
            isSaving = false
            saveFailed = !saved
            if saved { dismiss() }
        }
    }
}

/// Owner-managed remote tool servers. Connection discovery is intentionally
/// separate from tool use: a server can describe its tools here, but every
/// later invocation follows the owner's normal approval and autonomy policy.
private struct MCPConnectionsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var name = ""
    @State private var endpoint = ""
    @State private var bearerToken = ""
    @State private var isAdding = false
    @State private var workingConnectionID: String?
    @State private var showingAddConnection = false
    @State private var isLoading = false
    @State private var loadFailed = false
    @State private var hasLoaded = false
    @State private var actionFailed = false
    @FocusState private var focusedField: MCPField?

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                introduction
                if loadFailed {
                    AssistantLoadFailureState(
                        title: "Couldn’t refresh connected tools",
                        message: hasLoaded || !model.mcpConnections.isEmpty ? "Previous connections are shown. Refresh before changing them." : "Try again to check your connections.",
                        retry: { Task { await load() } }
                    )
                }
                if actionFailed {
                    AssistantInlineFailure(message: "Couldn’t confirm that change. Your entries are kept. Try again or pull to refresh.")
                        .assistantPanel(in: colorScheme)
                }
                if isLoading && !hasLoaded && model.mcpConnections.isEmpty {
                    AssistantLoadingState(title: "Loading connected tools")
                } else if model.mcpConnections.isEmpty && !loadFailed && hasLoaded {
                    AssistantEmptyState(
                        "No connected tools",
                        systemImage: "point.3.connected.trianglepath.dotted",
                        description: "Connect a tool service for your assistant to use."
                    )
                } else {
                    ForEach(model.mcpConnections) { connection in
                        connectionCard(connection)
                    }
                }
                addConnection
            }
            .padding(16)
            .padding(.bottom, 28)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .background(AssistantTheme.canvas(for: colorScheme).ignoresSafeArea())
        .navigationTitle("Connected tools")
        .assistantSubmenuChrome()
        .refreshable { await load() }
        .task { await load() }
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Connect services the assistant can use", systemImage: "checkmark.shield")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
            Text("MCP connects external tools to your assistant. Tool use follows your approval rules and autonomy settings.")
                .font(.subheadline)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 4)
    }

    private var addConnection: some View {
        DisclosureGroup(isExpanded: $showingAddConnection) {
            VStack(alignment: .leading, spacing: 13) {

                mcpField("Name", placeholder: "e.g. Home Assistant", text: $name, field: .name)
                mcpField("MCP endpoint", placeholder: "https://example.com/mcp", text: $endpoint, field: .endpoint)
                SecureField("Bearer token (optional)", text: $bearerToken)
                    .textContentType(.password)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .focused($focusedField, equals: .bearer)
                    .onSubmit(add)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 46)
                    .background(AssistantTheme.sunken(for: colorScheme), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                Button(action: add) {
                    HStack(spacing: 8) {
                        if isAdding { ProgressView().controlSize(.small) }
                        Text(isAdding ? "Checking connection…" : "Add and inspect")
                        Spacer()
                        Image(systemName: "arrow.right")
                            .font(.caption.weight(.bold))
                    }
                    .frame(minHeight: 40)
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .primary))
                .tint(AssistantTheme.accent(for: colorScheme))
                .disabled(isAdding || workingConnectionID != nil || isLoading || loadFailed || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .buttonStyle(AssistantTactileButtonStyle(reduceMotion: reduceMotion, pressedScale: 0.99))

                Text("Only public HTTPS endpoints are accepted in production. Bearer tokens are encrypted on the server and never shown again.")
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 8)
            .disabled(isAdding)
        } label: {
            Label("Add a connection", systemImage: "plus.circle")
                .font(.headline)
        }
        .assistantCard(in: colorScheme)
    }

    private func mcpField(
        _ label: String,
        placeholder: String,
        text: Binding<String>,
        field: MCPField
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            TextField(placeholder, text: text)
                .textContentType(field == .endpoint ? .URL : .organizationName)
                .keyboardType(field == .endpoint ? .URL : .default)
                .textInputAutocapitalization(field == .endpoint ? .never : .words)
                .autocorrectionDisabled(field == .endpoint)
                .submitLabel(.next)
                .focused($focusedField, equals: field)
                .onSubmit {
                    if field == .name { focusedField = .endpoint }
                    else { focusedField = .bearer }
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 46)
                .background(AssistantTheme.sunken(for: colorScheme), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private func connectionCard(_ connection: McpConnection) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                AssistantGlyph(systemName: connection.statusIcon, tint: statusColor(connection))
                VStack(alignment: .leading, spacing: 4) {
                    Text(connection.name)
                        .font(.headline)
                    Text(connection.serverName.map { version in
                        connection.serverVersion.map { "\(version) · \($0)" } ?? version
                    } ?? connection.endpoint)
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .lineLimit(usesAccessibilityLayout ? nil : 1)
                }
                Spacer(minLength: 6)
                statusTag(connection)
            }

            if connection.status == "ready" {
                HStack(spacing: 10) {
                    Label("\(connection.tools.count) \(connection.tools.count == 1 ? "tool" : "tools")", systemImage: "wrench.and.screwdriver")
                    if let checked = connection.lastCheckedAt { Text(checkedAtLabel(checked)) }
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))

                if !connection.tools.isEmpty {
                    FlowLayout(spacing: 6) {
                        ForEach(connection.tools.prefix(5)) { tool in
                            Text(tool.name)
                                .font(.caption2.monospaced().weight(.medium))
                                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 7)
                                .background(AssistantTheme.accent(for: colorScheme).opacity(0.1), in: Capsule())
                        }
                        if connection.tools.count > 5 {
                            Text("+\(connection.tools.count - 5)")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 7)
                                .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
                        }
                    }
                }
            } else if let error = connection.lastError, !error.isEmpty {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.errorInk(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }

            connectionActions(connection)
        }
        .assistantCard(in: colorScheme)
    }

    private func checkedAtLabel(_ value: String) -> String {
        guard let date = value.assistantDate else { return "Checked recently" }
        let seconds = max(0, Date().timeIntervalSince(date))
        if seconds < 60 { return "Checked just now" }
        return "Checked \(relative(value))"
    }

    @ViewBuilder
    private func connectionActions(_ connection: McpConnection) -> some View {
        let isWorking = workingConnectionID == connection.id
        if usesAccessibilityLayout {
            VStack(spacing: 9) {
                actionButton("Refresh", icon: "arrow.clockwise", connection: connection, action: "refresh", prominent: true, working: isWorking)
                actionButton(connection.enabled ? "Pause" : "Enable", icon: connection.enabled ? "pause.fill" : "play.fill", connection: connection, action: connection.enabled ? "disable" : "enable", prominent: false, working: isWorking)
                deleteButton(connection, working: isWorking)
            }
        } else {
            HStack(spacing: 9) {
                actionButton("Refresh", icon: "arrow.clockwise", connection: connection, action: "refresh", prominent: true, working: isWorking)
                actionButton(connection.enabled ? "Pause" : "Enable", icon: connection.enabled ? "pause.fill" : "play.fill", connection: connection, action: connection.enabled ? "disable" : "enable", prominent: false, working: isWorking)
                deleteButton(connection, working: isWorking)
            }
        }
    }

    @ViewBuilder
    private func actionButton(
        _ title: String,
        icon: String,
        connection: McpConnection,
        action: String,
        prominent: Bool,
        working: Bool
    ) -> some View {
        if prominent {
            Button { perform(connection, action: action) } label: {
                actionButtonLabel(title, icon: icon, working: working)
            }
            .buttonStyle(AssistantActionButtonStyle(kind: .primary))
            .tint(AssistantTheme.accent(for: colorScheme))
            .disabled(workingConnectionID != nil || isAdding || isLoading || loadFailed)
        } else {
            Button { perform(connection, action: action) } label: {
                actionButtonLabel(title, icon: icon, working: working)
            }
            .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
            .tint(AssistantTheme.inkMuted(for: colorScheme))
            .disabled(workingConnectionID != nil || isAdding || isLoading || loadFailed)
        }
    }

    private func actionButtonLabel(_ title: String, icon: String, working: Bool) -> some View {
        HStack(spacing: 6) {
            if working { ProgressView().controlSize(.small) }
            else { Image(systemName: icon) }
            Text(working ? "Working…" : title)
        }
        .frame(maxWidth: .infinity, minHeight: 36)
    }

    private func deleteButton(_ connection: McpConnection, working: Bool) -> some View {
        AssistantConfirmationButton("Remove", hint: "Deletes \(connection.name), its tools, and saved credential.") {
            guard workingConnectionID == nil, !isAdding, !isLoading, !loadFailed else { return }
            workingConnectionID = connection.id
            actionFailed = !(await model.deleteMcpConnection(id: connection.id))
            workingConnectionID = nil
        }
        .disabled(workingConnectionID != nil || working || isAdding || isLoading || loadFailed)
    }

    private func statusTag(_ connection: McpConnection) -> some View {
        Text(connection.statusLabel)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(statusColor(connection))
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .background(statusColor(connection).opacity(0.11), in: Capsule())
    }

    private func statusColor(_ connection: McpConnection) -> Color {
        switch connection.status {
        case "ready": AssistantTheme.success(for: colorScheme)
        case "checking": AssistantTheme.accent(for: colorScheme)
        case "disabled": AssistantTheme.inkMuted(for: colorScheme)
        case "error": AssistantTheme.errorInk(for: colorScheme)
        default: AssistantTheme.warning(for: colorScheme)
        }
    }

    private func add() {
        let candidateName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidateEndpoint = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isAdding, workingConnectionID == nil, !isLoading, !loadFailed, !candidateName.isEmpty, !candidateEndpoint.isEmpty else { return }
        focusedField = nil
        isAdding = true
        actionFailed = false
        Task {
            let added = await model.createMcpConnection(name: candidateName, endpoint: candidateEndpoint, bearerToken: bearerToken.isEmpty ? nil : bearerToken)
            if added {
                name = ""
                endpoint = ""
                bearerToken = ""
                showingAddConnection = false
            }
            actionFailed = !added
            isAdding = false
        }
    }

    private func perform(_ connection: McpConnection, action: String) {
        guard workingConnectionID == nil, !isAdding, !isLoading, !loadFailed else { return }
        actionFailed = false
        workingConnectionID = connection.id
        Task {
            actionFailed = !(await model.updateMcpConnection(id: connection.id, action: action))
            workingConnectionID = nil
        }
    }

    private func load() async {
        guard !isLoading, !isAdding, workingConnectionID == nil else { return }
        isLoading = true
        let refreshed = await model.refreshMcpConnections()
        isLoading = false
        guard !Task.isCancelled else { return }
        loadFailed = !refreshed
        if refreshed {
            if !hasLoaded && model.mcpConnections.isEmpty { showingAddConnection = true }
            hasLoaded = true
            actionFailed = false
        }
    }
}

private enum MCPField: Hashable {
    case name
    case endpoint
    case bearer
}

/// A wrapping row for compact tool names. Unlike a horizontal scroller, all
/// discovered capabilities remain visible at once and retain their reading
/// order when Dynamic Type grows.
private struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let width = proposal.width ?? .greatestFiniteMagnitude
        var cursorX: CGFloat = 0
        var cursorY: CGFloat = 0
        var lineHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            let nextX = cursorX > 0 ? cursorX + spacing + size.width : size.width
            if cursorX > 0, nextX > width {
                cursorX = 0
                cursorY += lineHeight + spacing
                lineHeight = 0
            }
            cursorX = cursorX > 0 ? cursorX + spacing + size.width : size.width
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: proposal.width ?? cursorX, height: cursorY + lineHeight)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        var cursorX = bounds.minX
        var cursorY = bounds.minY
        var lineHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if cursorX > bounds.minX, cursorX + size.width > bounds.maxX {
                cursorX = bounds.minX
                cursorY += lineHeight + spacing
                lineHeight = 0
            }
            subview.place(at: CGPoint(x: cursorX, y: cursorY), proposal: .unspecified)
            cursorX += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}

#if DEBUG
// Real private destinations exposed only to the isolated native screenshot suite.
extension MoreView {
    @MainActor static func visualReviewScreen(_ name: String, workspace: WorkspaceResponse) -> AnyView? {
        switch name {
        case "reminders": return AnyView(RemindersView())
        case "assistant-settings": return AnyView(AgentSettingsEditor(settings: workspace.settings.agent))
        case "connected-tools": return AnyView(MCPConnectionsView())
        default: return nil
        }
    }
}
#endif
