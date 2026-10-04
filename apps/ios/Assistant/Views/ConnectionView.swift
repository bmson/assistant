import SwiftUI

struct ConnectionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let isOnboarding: Bool
    let showsDoneButton: Bool

    @State private var serverURL = ""
    @State private var token = ""
    @State private var connecting = false
    @State private var connectionSuccessFeedback = 0
    @State private var connectionErrorFeedback = 0
    @FocusState private var focusedField: ConnectionField?

    init(isOnboarding: Bool, showsDoneButton: Bool = false) {
        self.isOnboarding = isOnboarding
        self.showsDoneButton = showsDoneButton
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                if isOnboarding { introduction }

                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 7) {
                        Text("Assistant server").font(.subheadline.weight(.semibold))
                        connectionFieldSurface(isFocused: focusedField == .server) {
                            TextField("https://assistant.example.com", text: $serverURL)
                                .textContentType(.URL)
                                .keyboardType(.URL)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .submitLabel(.next)
                                .focused($focusedField, equals: .server)
                                .onSubmit { focusedField = .token }
                        }
                    }

                    VStack(alignment: .leading, spacing: 7) {
                        Text("Mobile access key").font(.subheadline.weight(.semibold))
                        connectionFieldSurface(isFocused: focusedField == .token) {
                            SecureField("Paste your access key", text: $token)
                                .textContentType(.password)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .submitLabel(.go)
                                .focused($focusedField, equals: .token)
                                .onSubmit(connect)
                        }
                        Text("Generate a mobile access key in your assistant’s web Settings, then paste it here. It stays in this device’s Keychain.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .assistantCard(in: colorScheme)

                if let error = model.errorMessage {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline)
                        .foregroundStyle(.red)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            Color.red.opacity(colorScheme == .dark ? 0.15 : 0.08),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                        )
                        .accessibilityElement(children: .combine)
                }

                Button(action: connect) {
                    HStack {
                        if connecting { ProgressView().tint(.white) }
                        Text(connecting ? "Connecting…" : "Save and connect")
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .primary))
                .tint(AssistantTheme.accent(for: colorScheme))
                .disabled(connecting || serverURL.trimmingCharacters(in: .whitespaces).isEmpty)

                Text("Open Settings → Mobile app on your assistant’s website to find the server address and generate an access key.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(20)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .background(AssistantTheme.canvas(for: colorScheme).ignoresSafeArea())
        .navigationTitle(isOnboarding ? "Connect Assistant" : "Connection")
        .navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.success, trigger: connectionSuccessFeedback)
        .sensoryFeedback(.error, trigger: connectionErrorFeedback)
        .toolbar {
            if showsDoneButton {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onAppear {
            serverURL = model.serverURL
            token = KeychainStore.readToken()
            // The onboarding form can appear *because* the automatic connect
            // failed; clearing here would wipe the reason before it renders.
            // Only the deliberately opened settings sheet starts clean.
            if !isOnboarding { model.dismissError() }
        }
    }

    @ViewBuilder
    private func connectionFieldSurface<Content: View>(
        isFocused: Bool,
        @ViewBuilder content: () -> Content
    ) -> some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)

        content()
            .padding(.horizontal, 13)
            .frame(minHeight: 48)
            .background(AssistantTheme.sunken(for: colorScheme), in: shape)
            .overlay {
                shape.strokeBorder(
                    isFocused
                        ? AssistantTheme.accent(for: colorScheme).opacity(0.78)
                        : .primary.opacity(colorSchemeContrast == .increased ? 0.2 : 0.065),
                    lineWidth: isFocused || colorSchemeContrast == .increased ? 1.15 : 0.7
                )
            }
            .shadow(
                color: AssistantTheme.accent(for: colorScheme).opacity(isFocused ? 0.1 : 0),
                radius: 7,
                y: 2
            )
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.16),
                value: isFocused
            )
    }

    private func connect() {
        guard !connecting,
              !serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }

        focusedField = nil
        connecting = true
        Task {
            let connected = await model.saveConnection(serverURL: serverURL, token: token)
            connecting = false
            if connected {
                connectionSuccessFeedback += 1
                if !isOnboarding { dismiss() }
            } else {
                connectionErrorFeedback += 1
            }
        }
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Your assistant, at home on iPhone.")
                .font(.largeTitle.bold())
            Text("Chat, follow long-running work, manage goals, and approve real-world actions from a native interface. Your data and agent stay on the server you control.")
                .font(.body)
                .foregroundStyle(.secondary)
                .lineSpacing(4)
        }
    }
}

private enum ConnectionField: Hashable {
    case server
    case token
}
