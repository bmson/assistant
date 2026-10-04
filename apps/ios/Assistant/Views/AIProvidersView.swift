import SwiftUI

/// Settings → AI providers: which services power the assistant, and which of
/// their models it uses. The same server actions back the web Settings page,
/// so either surface can be used and the other shows the result.
struct AIProvidersView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @State private var mainModel = ""
    @State private var fastModel = ""
    @State private var isSaving = false
    @State private var savedNotice = false
    @State private var seeded = false
    @State private var baselineMainModel = ""
    @State private var baselineFastModel = ""
    @State private var isLoading = false
    @State private var loadFailed = false
    @State private var actionFailed = false

    private var settings: ModelProviderSettings? { model.modelProviders }

    var body: some View {
        AssistantForm {
            Group {
                if loadFailed {
                    Section {
                        AssistantLoadFailureState(
                            title: "Couldn’t refresh AI providers",
                            message: settings == nil ? "Try again to load your providers and models." : "Previous providers are shown. Refresh before changing them.",
                            retry: { Task { await load() } }
                        )
                    }
                }
                if actionFailed {
                    Section { AssistantInlineFailure(message: "Couldn’t confirm that change. Your choices are kept; try again.") }
                }
                if let settings {
                    modelsSection(settings)
                        .disabled(isSaving || isLoading || loadFailed)
                    voiceSection(settings)
                        .disabled(isSaving || isLoading || loadFailed)
                    Section {
                        ForEach(settings.connections) { connection in
                            NavigationLink {
                                ModelConnectionDetailView(connectionID: connection.id)
                            } label: {
                                connectionRow(connection, settings: settings)
                            }
                        }
                        NavigationLink {
                            ConnectProviderView()
                        } label: {
                            Label("Connect a provider", systemImage: "plus.circle")
                        }
                    } header: {
                        Text("Providers")
                    } footer: {
                        Text("API keys are encrypted on your server and never sent back to this phone.")
                    }
                    .disabled(isSaving || isLoading || loadFailed)
                } else {
                    if !loadFailed { Section { ProgressView("Loading AI providers") } }
                }
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle("AI providers")
        .assistantSubmenuChrome()
        .task { await load() }
        .refreshable { await load() }
        // Follow server defaults while there is no local edit. A refresh must
        // not silently replace a choice that is still waiting for Save.
        .onChange(of: settings?.mainModel) { _, _ in acceptDefaults() }
        .onChange(of: settings?.fastModel) { _, _ in acceptDefaults() }
    }

    private var hasUnsavedModels: Bool {
        mainModel != baselineMainModel || fastModel != baselineFastModel
    }

    private func acceptDefaults() {
        guard let settings else { return }
        if !seeded || mainModel == baselineMainModel {
            mainModel = settings.mainModel ?? ""
        }
        if !seeded || fastModel == baselineFastModel {
            fastModel = settings.fastModel ?? ""
        }
        baselineMainModel = settings.mainModel ?? ""
        baselineFastModel = settings.fastModel ?? ""
        seeded = true
    }

    private func load() async {
        guard !isLoading, !isSaving else { return }
        isLoading = true
        let refreshed = await model.refreshModelProviders()
        isLoading = false
        guard !Task.isCancelled else { return }
        loadFailed = !refreshed
        if refreshed { acceptDefaults() }
    }

    private func modelsSection(_ settings: ModelProviderSettings) -> some View {
        Section {
            modelPicker("Main model", selection: $mainModel, settings: settings)
            modelPicker("Fast model", selection: $fastModel, settings: settings)
            Button {
                guard !isSaving else { return }
                isSaving = true
                actionFailed = false
                let selectedMain = mainModel, selectedFast = fastModel
                Task {
                    savedNotice = await model.chooseTextModels(main: selectedMain, fast: selectedFast)
                    actionFailed = !savedNotice
                    if savedNotice {
                        baselineMainModel = selectedMain
                        baselineFastModel = selectedFast
                    }
                    isSaving = false
                }
            } label: {
                HStack {
                    Text(isSaving ? "Saving…" : "Use these models")
                    Spacer()
                    if isSaving { ProgressView() }
                    else if savedNotice && !hasUnsavedModels { Image(systemName: "checkmark").foregroundStyle(AssistantTheme.success(for: colorScheme)).accessibilityLabel("Saved") }
                }
            }
            .disabled(
                isSaving || mainModel.isEmpty || fastModel.isEmpty
                    || !hasUnsavedModels
            )
        } header: {
            Text("Models")
        } footer: {
            Text("The main model plans, uses tools and writes your replies. The fast model sorts, extracts and rewrites in the background.")
        }
    }

    private func voiceSection(_ settings: ModelProviderSettings) -> some View {
        let chosen = settings.models.first { $0.id == settings.voiceModel }
        let presets = settings.voicePresets ?? []
        return Section {
            if !settings.voiceGroups.isEmpty {
                NavigationLink {
                    ModelChoiceList(
                        title: "Voice model",
                        groups: settings.voiceGroups,
                        selection: Binding(
                            get: { settings.voiceModel ?? "" },
                            set: { id in run { await model.chooseVoiceModel(id) } }
                        )
                    )
                } label: {
                    LabeledContent("Voice model", value: chosen?.label ?? "Choose")
                }
            }
            ForEach(presets) { preset in
                Button {
                    run { await model.addVoicePreset(connectionId: preset.connectionId, model: preset.model) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Label("Add \(preset.label)", systemImage: "plus.circle")
                        Text(preset.note)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            if settings.voiceGroups.isEmpty && presets.isEmpty {
                Text("Connect OpenAI or Google Vertex AI to add a voice model.")
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Voice model (phone calls)")
        } footer: {
            Text("Used for outgoing phone calls. Read-aloud voice and hands-free conversation are controlled in More → Speech.")
        }
    }

    private func run(_ work: @escaping () async -> Bool) {
        guard !isSaving, !isLoading, !loadFailed else { return }
        isSaving = true
        actionFailed = false
        Task {
            actionFailed = !(await work())
            isSaving = false
        }
    }

    private func modelPicker(
        _ title: String,
        selection: Binding<String>,
        settings: ModelProviderSettings
    ) -> some View {
        let chosen = settings.models.first { $0.id == selection.wrappedValue }
        return NavigationLink {
            ModelChoiceList(title: title, groups: settings.choosableGroups, selection: selection)
        } label: {
            LabeledContent(title, value: chosen?.label ?? (selection.wrappedValue.isEmpty ? "Choose" : selection.wrappedValue))
        }
        .onChange(of: selection.wrappedValue) { _, _ in savedNotice = false }
    }

    private func connectionRow(_ connection: ModelConnection, settings: ModelProviderSettings) -> some View {
        let count = settings.models.filter { $0.connectionId == connection.id && $0.enabled }.count
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(connection.label)
                if !connection.enabled {
                    Text("Off").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                } else if connection.lastError != nil {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                        .accessibilityLabel("Needs attention")
                }
            }
            Text("\(connection.kindLabel) · \(count) \(count == 1 ? "model" : "models")")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

/// Pick one chat model, grouped under the provider that serves it.
private struct ModelChoiceList: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    let title: String
    let groups: [(connection: ModelConnection, models: [CatalogModel])]
    @Binding var selection: String

    var body: some View {
        AssistantForm {
            Group {
                if groups.isEmpty {
                    Section { Text("No enabled models are available. Connect a provider or add a model first.").foregroundStyle(.secondary) }
                }
                ForEach(groups, id: \.connection.id) { group in
                    Section(group.connection.label) {
                        ForEach(group.models) { catalogModel in
                            Button {
                                selection = catalogModel.id
                                dismiss()
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(catalogModel.label)
                                        Text(catalogModel.priceLabel)
                                            .font(.caption.monospacedDigit())
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if catalogModel.id == selection {
                                        Image(systemName: "checkmark")
                                            .font(.body.weight(.semibold))
                                            .foregroundStyle(.tint)
                                            .accessibilityLabel("Selected")
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle(title)
        .assistantSubmenuChrome()
    }
}

/// One connection: its status, its models, and the controls that change it.
private struct ModelConnectionDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    let connectionID: String

    @State private var listing: [ProviderModelListing]?
    @State private var isTesting = false
    @State private var isWorking = false
    @State private var newModel = ""
    @State private var inputPrice = ""
    @State private var outputPrice = ""
    @State private var actionFailed = false
    @State private var showingRemovalConfirmation = false

    private var connection: ModelConnection? {
        model.modelProviders?.connections.first { $0.id == connectionID }
    }

    private var models: [CatalogModel] {
        model.modelProviders?.models.filter { $0.connectionId == connectionID } ?? []
    }

    var body: some View {
        AssistantForm {
            Group {
                if actionFailed {
                    Section { AssistantInlineFailure(message: "Couldn’t confirm that change. Your entries are kept; try again.") }
                }
                if let connection {
                    Section {
                        LabeledContent("Type", value: connection.kindLabel)
                        if let url = connection.baseUrl { LabeledContent("Base URL", value: url) }
                        LabeledContent(
                            "Credentials",
                            value: connection.source == "environment"
                                ? "Set up with this deployment"
                                : connection.kind == "vertex"
                                    ? "Server’s Google credentials"
                                    : connection.hasApiKey ? "API key saved" : "No API key"
                        )
                        if let error = connection.lastError {
                            Label(error, systemImage: "exclamationmark.triangle")
                                .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                        }
                        Button {
                            guard !isTesting, !isWorking else { return }
                            isTesting = true
                            actionFailed = false
                            Task {
                                listing = await model.testModelProvider(id: connectionID)
                                actionFailed = listing == nil
                                isTesting = false
                            }
                        } label: {
                            HStack {
                                Text(isTesting ? "Testing…" : "Test connection")
                                Spacer()
                                if isTesting { ProgressView() }
                            }
                        }
                        .disabled(isTesting || isWorking)
                    }

                    Section("Models") {
                        if models.isEmpty {
                            Text("No models yet.").foregroundStyle(.secondary)
                        }
                        ForEach(models) { catalogModel in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(catalogModel.label)
                                Text(catalogModel.priceLabel)
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }

                    addModelSection
                        .disabled(isTesting || isWorking)

                    Section {
                        Button(connection.enabled ? "Turn off" : "Turn on") {
                            run { await model.setModelProviderEnabled(id: connectionID, enabled: !connection.enabled) }
                        }
                        if connection.source == "saved" {
                            Button("Remove connection", role: .destructive) {
                                showingRemovalConfirmation = true
                            }
                        }
                    }
                    .disabled(isWorking || isTesting)
                } else {
                    Section { Text("This provider is no longer connected.").foregroundStyle(.secondary) }
                }
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle(connection?.label ?? "Provider")
        .assistantSubmenuChrome()
        .confirmationDialog("Remove provider?", isPresented: $showingRemovalConfirmation, titleVisibility: .visible) {
            Button("Remove provider", role: .destructive) {
                run {
                    let removed = await model.removeModelProvider(id: connectionID)
                    if removed { dismiss() }
                    return removed
                }
            }
        } message: {
            Text("This removes the connection and its saved credentials. Connect it again if you need its models later.")
        }
    }

    private var addModelSection: some View {
        Section {
            AssistantField("Model name") {
                TextField("Model name", text: $newModel)
            }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onChange(of: newModel) { _, value in
                    guard let match = listing?.first(where: { $0.model == value }) else { return }
                    if let price = match.promptCostPerMTok { inputPrice = price }
                    if let price = match.completionCostPerMTok { outputPrice = price }
                }
            if let listing, !listing.isEmpty {
                let matches = listing.filter {
                    newModel.isEmpty || $0.model.localizedCaseInsensitiveContains(newModel)
                }
                ForEach(matches.prefix(6)) { entry in
                    Button(entry.model) { newModel = entry.model }
                        .font(.callout.monospaced())
                }
            }
            AssistantField("Input price (USD per million tokens)") {
                TextField("$ per million input tokens", text: $inputPrice)
                    .keyboardType(.decimalPad)
            }
            AssistantField("Output price (USD per million tokens)") {
                TextField("$ per million output tokens", text: $outputPrice)
                    .keyboardType(.decimalPad)
            }
            Button("Add model") {
                let chosen = listing?.first { $0.model == newModel }
                run {
                    let added = await model.addProviderModel(
                        connectionId: connectionID,
                        model: newModel,
                        label: chosen?.label,
                        inputPrice: inputPrice,
                        outputPrice: outputPrice,
                        thinking: chosen?.thinking
                    )
                    if added {
                        newModel = ""
                        inputPrice = ""
                        outputPrice = ""
                    }
                    return added
                }
            }
            .disabled(isWorking || newModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || inputPrice.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || outputPrice.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } header: {
            Text("Add a model")
        } footer: {
            Text("Prices keep your spending caps accurate; a model without them can’t be used. Test the connection to pick from its models.")
        }
    }

    private func run(_ work: @escaping () async -> Bool) {
        guard !isWorking, !isTesting else { return }
        isWorking = true
        actionFailed = false
        Task {
            actionFailed = !(await work())
            isWorking = false
        }
    }
}

/// Connect OpenAI, OpenRouter, Vertex, or any OpenAI-compatible gateway.
private struct ConnectProviderView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @State private var kind = "openai"
    @State private var gatewayID = ""
    @State private var label = ""
    @State private var apiKey = ""
    @State private var baseUrl = ""
    @State private var project = ""
    @State private var location = ""
    @State private var isSaving = false
    @State private var testError: String?
    @State private var submissionFailed = false
    @State private var savedProviderID: String?

    var body: some View {
        AssistantForm {
            Group {
                Section {
                    Picker("Provider", selection: $kind) {
                        ForEach(ModelConnection.kinds, id: \.self) { value in
                            Text(ModelConnection.kindLabel(value)).tag(value)
                        }
                    }
                    AssistantField("Name (optional)") {
                        TextField("Name (optional)", text: $label)
                    }
                }
                if kind == "openai_compatible" {
                    Section {
                        AssistantField("Provider ID") {
                            TextField("Short id, e.g. groq", text: $gatewayID)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                        AssistantField("Base URL") {
                            TextField("Base URL", text: $baseUrl)
                                .keyboardType(.URL)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                    }
                }
                if kind == "vertex" {
                    Section {
                        AssistantField("Google Cloud project (optional)") {
                            TextField("Google Cloud project (optional)", text: $project)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                        AssistantField("Location") {
                            TextField("Location, e.g. us-central1", text: $location)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                    } footer: {
                        Text("Vertex uses your server’s own Google Cloud credentials, so there’s no key to paste.")
                    }
                } else {
                    Section {
                        AssistantField("API key") {
                            SecureField("API key", text: $apiKey)
                                .textContentType(.password)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                    } footer: {
                        Text("Stored encrypted on your server and never shown again.")
                    }
                }
                if let testError {
                    Section {
                        Label("Connected, but the test failed: \(testError)", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                    } footer: {
                        Text("Open this provider from the providers list to test it again or check its models.")
                    }
                }
                if submissionFailed {
                    Section { AssistantInlineFailure(message: "Couldn’t connect this provider. Your entries are kept; try again.") }
                }
            }
            .disabled(isSaving || savedProviderID != nil)
            .listRowBackground(AssistantTheme.raised(for: colorScheme))
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle("Connect a provider")
        .assistantSubmenuChrome()
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(savedProviderID != nil ? "Done" : isSaving ? "Connecting…" : "Connect") {
                    if savedProviderID != nil { dismiss() } else { connect() }
                }
                .disabled(isSaving || (savedProviderID == nil && kind == "openai_compatible" && (gatewayID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || baseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)))
            }
        }
    }

    private func connect() {
        guard !isSaving, savedProviderID == nil else { return }
        isSaving = true
        submissionFailed = false
        testError = nil
        let cleanID = gatewayID.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanURL = baseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanProject = project.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanLocation = location.trimmingCharacters(in: .whitespacesAndNewlines)
        let input = ModelConnectionInput(
            kind: kind,
            id: kind == "openai_compatible" ? cleanID : nil,
            label: cleanLabel.isEmpty ? nil : cleanLabel,
            apiKey: cleanKey.isEmpty ? nil : cleanKey,
            baseUrl: kind == "openai_compatible" ? cleanURL : nil,
            vertexProject: kind == "vertex" && !cleanProject.isEmpty ? cleanProject : nil,
            vertexLocation: kind == "vertex" && !cleanLocation.isEmpty ? cleanLocation : nil
        )
        Task {
            let result = await model.connectModelProvider(input)
            isSaving = false
            guard let result else { submissionFailed = true; return }
            apiKey = ""
            savedProviderID = result.id
            if let error = result.testError { testError = error } else { dismiss() }
        }
    }
}

#if DEBUG
extension AIProvidersView {
    @MainActor static func visualReviewScreen(_ name: String, providers: ModelProviderSettings) -> AnyView? {
        switch name {
        case "connect-provider": return AnyView(ConnectProviderView())
        case "provider-detail": return AnyView(ModelConnectionDetailView(connectionID: providers.connections.first?.id ?? "provider"))
        case "choose-model": return AnyView(ModelChoiceList(title: "Default chat model", groups: providers.choosableGroups, selection: .constant(providers.mainModel ?? "")))
        default: return nil
        }
    }
}
#endif
