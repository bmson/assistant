import SwiftUI

/// Phone calls the assistant placed, and — while one is live — the question it
/// is waiting on you for and a way to hang up.
struct CallsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @State private var calls: [PhoneCall]?
    @State private var loadFailed = false

    var body: some View {
        AssistantForm {
            Group {
                if loadFailed {
                    AssistantLoadFailureState(
                        title: "Calls couldn’t be loaded",
                        message: calls == nil ? "Try again when your assistant is reachable." : "Your last loaded calls are shown below."
                    ) { Task { await reload() } }
                }
                if let calls {
                    if calls.isEmpty {
                        Text("No calls yet. Ask the assistant in chat to call someone for you.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(calls) { call in
                        NavigationLink {
                            CallDetailView(callID: call.id)
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    Text(call.title)
                                    if call.openCheckin != nil {
                                        Image(systemName: "questionmark.bubble.fill")
                                            .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                                            .accessibilityLabel("Needs your answer")
                                    }
                                }
                                Text("\(call.statusLabel) · \(call.summary ?? call.brief.goal)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                    }
                } else if !loadFailed {
                    AssistantLoadingState(title: "Loading calls")
                }
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle("Calls")
        .assistantSubmenuChrome()
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await reload()
        }
        .refreshable { await reload() }
    }

    private func reload() async {
        let result = await model.loadPhoneCalls()
        guard !Task.isCancelled else { return }
        if let result { calls = result }
        loadFailed = result == nil
    }
}

private struct CallDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    let callID: String
    @State private var call: PhoneCall?
    @State private var answer = ""
    @State private var sending = false
    @State private var loadFailed = false
    @State private var refreshGeneration = 0

    var body: some View {
        AssistantForm {
            Group {
                if loadFailed {
                    AssistantLoadFailureState(
                        title: "The call couldn’t be updated",
                        message: call == nil ? "Try again to check the call." : "The last update is shown below. Try again to follow the call."
                    ) { refreshGeneration += 1 }
                }
                if let call {
                    Section {
                        LabeledContent("Status", value: call.statusLabel)
                        Text(call.brief.goal)
                        if let summary = call.summary { Text(summary).foregroundStyle(.secondary) }
                    }
                    if call.active {
                        if let checkin = call.openCheckin {
                            Section("The assistant is asking you") {
                                Text("“\(checkin.question)”")
                                TextField("Your answer", text: $answer, axis: .vertical)
                                Button(sending ? "Sending…" : "Send answer") {
                                    sending = true
                                    Task {
                                        if await model.answerCallCheckin(callId: call.id, checkinId: checkin.id, answer: answer) {
                                            answer = ""
                                        }
                                        sending = false
                                        await reload()
                                    }
                                }
                                .disabled(sending || answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }
                        }
                        Section {
                            Button("Hang up", role: .destructive) {
                                guard !sending else { return }
                                sending = true
                                Task {
                                    _ = await model.hangUpCall(callId: call.id)
                                    await reload()
                                    sending = false
                                }
                            }
                            .disabled(sending)
                        }
                    }
                    if !call.notes.isEmpty {
                        Section("Noted on the call") {
                            ForEach(call.notes, id: \.self) { Text($0) }
                        }
                    }
                    Section("Transcript") {
                        if call.transcript.isEmpty {
                            Text(call.active ? "Waiting for the conversation…" : "Nothing was said.")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(call.transcript, id: \.self) { line in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(line.role == "assistant" ? "Assistant" : line.role == "caller" ? "Them" : "·")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                Text(line.text)
                            }
                        }
                    }
                } else if !loadFailed {
                    AssistantLoadingState(title: "Loading the call")
                }
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle(call?.title ?? "Call")
        .assistantSubmenuChrome()
        .task(id: "\(scenePhase)-\(refreshGeneration)") {
            guard scenePhase == .active else { return }
            await reload()
            guard call != nil else { return }
            var failures = loadFailed ? 1 : 0
            // Follow only a visible live call. Cancellation must end the wait,
            // rather than falling through into one more network request.
            while !Task.isCancelled, call?.active == true, failures < 3 {
                do {
                    try await Task.sleep(for: .seconds(PollingPolicy.callIntervalSeconds(consecutiveFailures: failures)))
                } catch { return }
                guard !Task.isCancelled, scenePhase == .active else { return }
                await reload()
                failures = loadFailed ? failures + 1 : 0
            }
        }
    }

    private func reload() async {
        let fresh = await model.loadPhoneCall(id: callID)
        guard !Task.isCancelled else { return }
        if let fresh { call = fresh }
        loadFailed = fresh == nil
    }
}

#if DEBUG
extension CallsView {
    @MainActor static func visualReviewDetail() -> AnyView { AnyView(CallDetailView(callID: "call-1")) }
}
#endif
