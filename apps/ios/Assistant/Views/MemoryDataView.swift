import SwiftUI
import UIKit

/// Your data, and the writing voice the assistant drafts in.
///
/// Both of these existed on the web only. Export in particular is not a
/// convenience: a phone-only owner had no way to get their memory out of the
/// assistant at all, and no way to erase it, which is not a thing that should
/// depend on owning a laptop.
struct MemoryDataScreen: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var exporting = false
    @State private var exported: ExportedFile?
    @State private var forgetting = false
    @State private var dataActionFailed = false
    @State private var memoryErased = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if dataActionFailed {
                    AssistantInlineFailure(message: "Couldn’t confirm that request. Try again when your server is available.")
                }
                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Take your data with you").font(.headline)
                        Text("The saved facts, knowledge-graph connections, people profiles, and writing voice that shape recall. The export never includes credentials or embeddings.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Button {
                        export()
                    } label: {
                        HStack(spacing: 8) {
                            if exporting { ProgressView() }
                            Text(exporting ? "Preparing…" : "Export memory")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(AssistantActionButtonStyle(kind: .primary, fillsWidth: true))
                    .disabled(exporting || forgetting)
                }
                .assistantPanel(in: colorScheme)

                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Forget long-term memory").font(.headline)
                        Text("Permanently deletes saved facts, graph connections, voice samples, and the learned voice profile. Chats, goals, people records, and connected accounts are left intact.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    AssistantConfirmationButton(
                        "Forget long-term memory",
                        confirmationTitle: "Erase memory and voice",
                        hint: "This cannot be undone.",
                        fillsWidth: true
                    ) {
                        guard !exporting, !forgetting else { return }
                        forgetting = true
                        dataActionFailed = false
                        memoryErased = false
                        let erased = await model.forgetLongTermMemory()
                        dataActionFailed = !erased
                        memoryErased = erased
                        forgetting = false
                    }
                    .disabled(exporting || forgetting)
                    if forgetting {
                        ProgressView("Erasing memory")
                    } else if memoryErased {
                        Label("Long-term memory erased", systemImage: "checkmark.circle")
                            .font(.subheadline)
                            .foregroundStyle(AssistantTheme.success(for: colorScheme))
                    }
                    Text("Erasure keeps only anonymous content hashes, so forgotten facts are not picked up again the next time they are mentioned.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .assistantPanel(in: colorScheme)
            }
            .padding(16)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("Your data")
        .assistantSubmenuChrome()
        .sheet(item: $exported) { file in
            ShareSheet(url: file.url)
        }
    }

    private func export() {
        guard !exporting, !forgetting else { return }
        exporting = true
        dataActionFailed = false
        Task {
            if let url = await model.exportMemoryFile() {
                exported = ExportedFile(url: url)
            } else {
                dataActionFailed = true
            }
            exporting = false
        }
    }
}

/// A temporary file on its way to the share sheet.
private struct ExportedFile: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

/// The system share sheet. SwiftUI's ShareLink wants its item up front, and the
/// export does not exist until the server has been asked for it.
private struct ShareSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Edit the distilled voice rather than only the samples behind it.
///
/// iOS could upload sent messages and clear them, but the profile those samples
/// produce — the description the drafting step actually reads — was web-only.
struct VoiceProfileEditor: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @State private var description = ""
    @State private var dos = ""
    @State private var donts = ""
    @State private var signature = ""
    @State private var loaded = false
    @State private var isLoading = false
    @State private var loadFailed = false
    @State private var isSaving = false
    @State private var saveFailed = false

    var body: some View {
        AssistantForm {
            if loadFailed {
                Section {
                    AssistantLoadFailureState(
                        title: "Writing voice unavailable",
                        message: "Your saved writing voice couldn’t be loaded. Try again before making changes.",
                        retry: { Task { await load() } }
                    )
                }
                .listRowBackground(AssistantTheme.raised(for: colorScheme))
            } else if !loaded {
                Section {
                    ProgressView("Loading writing voice")
                }
                .listRowBackground(AssistantTheme.raised(for: colorScheme))
            }
            if saveFailed {
                Section {
                    AssistantInlineFailure(message: "Couldn’t save your writing voice. Your changes are still here; try again.")
                }
                .listRowBackground(AssistantTheme.raised(for: colorScheme))
            }
            Section {
                TextField(
                    "How you write: tone, sentence length, what you never do",
                    text: $description,
                    axis: .vertical
                )
                .lineLimit(3...10)
            } header: {
                Text("Your voice")
            } footer: {
                Text("This is what the assistant reads before it drafts anything on your behalf.")
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))
            .disabled(!loaded || isSaving)

            Section {
                TextField("One per line", text: $dos, axis: .vertical)
                    .lineLimit(2...8)
            } header: {
                Text("Always")
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))
            .disabled(!loaded || isSaving)

            Section {
                TextField("One per line", text: $donts, axis: .vertical)
                    .lineLimit(2...8)
            } header: {
                Text("Never")
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))
            .disabled(!loaded || isSaving)

            Section("Sign-off") {
                TextField("How you end a message", text: $signature)
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))
            .disabled(!loaded || isSaving)
        }
        .scrollContentBackground(.hidden)
        .toolbarBackground(.visible, for: .navigationBar)
        .navigationTitle("Writing voice")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(isSaving)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
                    .disabled(isSaving)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") { save() }
                    .disabled(
                        isSaving
                            || !loaded
                            || description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard !loaded, !isLoading, !isSaving else { return }
        isLoading = true
        loadFailed = false
        let response = await model.voiceProfile()
        isLoading = false
        guard !Task.isCancelled else { return }
        guard let response else {
            loadFailed = true
            return
        }
        description = response.voiceProfile.description
        dos = response.voiceProfile.dos.joined(separator: "\n")
        donts = response.voiceProfile.donts.joined(separator: "\n")
        signature = response.voiceProfile.signature
        loaded = true
    }

    private func save() {
        guard loaded, !isSaving, !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        isSaving = true
        saveFailed = false
        Task {
            let saved = await model.saveVoiceProfile(
                VoiceProfileMutation(
                    description: description,
                    dos: dos,
                    donts: donts,
                    signature: signature
                )
            )
            isSaving = false
            saveFailed = !saved
            if saved { dismiss() }
        }
    }
}
