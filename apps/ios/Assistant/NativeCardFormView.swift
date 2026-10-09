import SwiftUI

struct NativeCardFormActions {
    let load: (CardFormDescriptor) async throws -> (CardFormScope, CardFormDraft)
    let setValue: (CardFormScope, CardFormDescriptor, String, CardFormValue?) async throws -> CardFormDraft
    let review: (CardFormScope, CardFormDescriptor, Bool) async throws -> CardFormDraft
    let attachToMessage: (CardFormScope, CardFormDescriptor, String) -> Void
    let retryUnknown: (CardFormScope, CardFormDescriptor) -> Void
    let resumeRejected: (CardFormScope) async throws -> CardFormDraft
    let taskStatus: (String) -> String?
    let startNextEntry: (CardFormScope, String) async throws -> CardFormDraft
    let observeActiveTask: (CardFormScope, CardFormDescriptor, CardFormActiveTaskPointer) -> Void
}

/// A small, single-column native editor. Values are saved by field ID as the
/// owner types; this view never admits work itself. The ordinary composer Send
/// remains the only initial admission point.
struct NativeCardFormView: View {
    let form: NativeCardForm
    let warningFacts: [MessageResponseCard.GeneratedFact]
    let actions: NativeCardFormActions
    let stateRevision: Int

    @Environment(\.colorScheme) private var colorScheme
    @State private var scope: CardFormScope?
    @State private var draft: CardFormDraft?
    @State private var loading = false
    @State private var error: String?
    @State private var showRevisionReview = false
    @State private var editSequence = 0
    @State private var editTask: Task<Void, Never>?
    @State private var editFailure: String?

    private var descriptor: CardFormDescriptor { form.descriptor }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(descriptor.title)
                .font(.headline.weight(.semibold))
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)

            ForEach(warningFacts, id: \.id) { fact in
                Text("\(fact.label): \(fact.value)")
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }

            if loading && draft == nil {
                ProgressView("Loading saved answers…")
                    .font(.subheadline)
            } else if let draft {
                if let editFailure {
                    Text(editFailure)
                        .font(.subheadline)
                        .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("cardFormSecureSaveWarning")
                }
                if let error, error != editFailure {
                    Text(error)
                        .font(.subheadline)
                        .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("cardFormActionWarning")
                }
                if let pending = draft.pendingReview {
                    revisionNotice(pending.revisionId)
                }
                switch draft.phase {
                case .idle:
                    fieldList(draft)
                    Button("Review in message") {
                        Task { await reviewInMessage() }
                    }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                    .disabled(draft.pendingReview != nil || draft.requiresFreshRevision || editFailure != nil)
                    .accessibilityHint("Places this form in the editable message box. Nothing is sent until you press Send.")
                case .submitting:
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Saving this request…")
                            .font(.subheadline)
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    }
                case .outcomeUnknown:
                    Text("The send result is unknown. Retry the saved request to check it safely.")
                        .font(.subheadline)
                        .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Retry same request") {
                        guard let scope else { return }
                        actions.retryUnknown(scope, descriptor)
                    }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                case let .accepted(receipt):
                    acceptedTask(receipt, draft: draft)
                case let .activeForm(pointer):
                    activeFormTask(pointer, draft: draft)
                case let .rejected(_, code):
                    Text(rejectionText(code))
                        .font(.subheadline)
                        .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                    if !draft.requiresFreshRevision && draft.pendingReview == nil {
                        Button("Edit and try again") {
                            Task { await resumeEditing(scope: draft.scope) }
                        }
                        .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                    }
                }
            } else if let error {
                Text(error)
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
                Button("Try loading again") { Task { await loadDraft() } }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: "\(descriptor.cardRevisionId):\(stateRevision)") { await loadDraft() }
        .confirmationDialog("Review updated form", isPresented: $showRevisionReview, titleVisibility: .visible) {
            Button("Keep compatible answers") { Task { await reviewRevision(carry: true) } }
            Button("Start with blank answers") { Task { await reviewRevision(carry: false) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This card changed. Check the updated fields before sending.")
        }
    }

    @ViewBuilder
    private func fieldList(_ current: CardFormDraft) -> some View {
        ForEach(descriptor.fields, id: \.id) { field in
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 4) {
                    Text(field.label)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    if field.required {
                        Text("Required")
                            .font(.caption)
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    }
                }
                fieldControl(field, value: current.values[field.id])
            }
        }
    }

    @ViewBuilder
    private func fieldControl(_ field: CardFormField, value: CardFormValue?) -> some View {
        switch field.type {
        case .text:
            TextField(field.label, text: textBinding(field.id, kind: .text))
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel(field.label)
        case .date:
            TextField("YYYY-MM-DD", text: textBinding(field.id, kind: .date))
                .textFieldStyle(.roundedBorder)
                .keyboardType(.numbersAndPunctuation)
                .textInputAutocapitalization(.never)
                .accessibilityLabel(field.label)
                .accessibilityHint("Enter a calendar date as year, month, and day.")
        case .choice:
            Picker(field.label, selection: textBinding(field.id, kind: .choice)) {
                if !field.required { Text("No answer").tag("") }
                else { Text("Choose an answer").tag("") }
                ForEach(field.options ?? [], id: \.id) { option in
                    Text(option.label).tag(option.id)
                }
            }
            .pickerStyle(.menu)
            .accessibilityLabel(field.label)
        case .boolean:
            Picker(field.label, selection: booleanBinding(field.id, value: value)) {
                Text("Choose").tag("")
                Text("Yes").tag("yes")
                Text("No").tag("no")
            }
            .pickerStyle(.segmented)
            .accessibilityLabel(field.label)
            .accessibilityHint("Choose Yes or No. No is a valid answer.")
        }
    }

    private func textBinding(_ fieldId: String, kind: CardFormFieldKind) -> Binding<String> {
        Binding(
            get: {
                guard let value = draft?.values[fieldId] else { return "" }
                switch value {
                case let .text(text), let .date(text), let .choice(text): return text
                case .boolean: return ""
                }
            },
            set: { text in
                guard text.utf16.count <= 500, let scope else {
                    if text.utf16.count > 500 { error = "Keep each answer within 500 characters." }
                    return
                }
                let value: CardFormValue?
                if text.isEmpty {
                    value = nil
                } else {
                    switch kind {
                    case .text: value = .text(text)
                    case .date: value = .date(text)
                    case .choice: value = .choice(text)
                    case .boolean: value = nil
                    }
                }
                queueOptimisticSave(value, fieldId: fieldId, scope: scope)
            }
        )
    }

    private func booleanBinding(_ fieldId: String, value: CardFormValue?) -> Binding<String> {
        Binding(
            get: {
                guard case let .boolean(value)? = value else { return "" }
                return value ? "yes" : "no"
            },
            set: { selected in
                guard let scope else { return }
                let value: CardFormValue? = switch selected {
                case "yes": .boolean(true)
                case "no": .boolean(false)
                default: nil
                }
                queueOptimisticSave(value, fieldId: fieldId, scope: scope)
            }
        )
    }

    private func revisionNotice(_ revisionId: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("This form has an update to review.")
                .font(.subheadline)
                .foregroundStyle(AssistantTheme.warning(for: colorScheme))
            Button("Review updated form") { showRevisionReview = true }
                .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                .accessibilityHint("Choose whether to keep answers whose fields still match or start fresh.")
        }
        .accessibilityIdentifier("assistant.card-form.revision-\(revisionId)")
    }

    @ViewBuilder
    private func acceptedTask(_ receipt: CardFormAdmissionReceipt, draft current: CardFormDraft) -> some View {
        let status = actions.taskStatus(receipt.taskId) ?? receipt.taskStatus
        VStack(alignment: .leading, spacing: 7) {
            Text(SuggestionTaskReceipt.title(for: status))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
            Text(SuggestionTaskReceipt.detail(for: status))
                .font(.subheadline)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
            if ["waiting_approval", "waiting_budget", "needs_attention"].contains(status) {
                Text("You can reply in the chat while this task waits. The form will stay tied to this task.")
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if ["done", "failed", "cancelled"].contains(status), current.pendingReview == nil,
               !current.requiresFreshRevision {
                if let scope {
                    Button("Review a new entry") { startNextEntry(scope, taskId: receipt.taskId) }
                        .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                        .accessibilityHint("Opens fresh answers in the message box. Nothing is sent until you press Send.")
                }
            } else if ["done", "failed", "cancelled"].contains(status), current.pendingReview != nil {
                Text("Review the updated form before starting another entry.")
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.warning(for: colorScheme))
            }
        }
    }

    private func loadDraft() async {
        await editTask?.value
        let startingSequence = editSequence
        loading = true
        error = nil
        defer { loading = false }
        do {
            let loaded = try await actions.load(descriptor)
            guard startingSequence == editSequence else { return }
            scope = loaded.0
            draft = loaded.1
            if case let .activeForm(pointer) = loaded.1.phase {
                actions.observeActiveTask(loaded.0, descriptor, pointer)
            }
        } catch {
            self.error = "Secure form storage is unavailable. You can keep chatting or try again."
        }
    }

    private func queueOptimisticSave(_ value: CardFormValue?, fieldId: String, scope: CardFormScope) {
        guard var current = draft else { return }
        editSequence += 1
        let sequence = editSequence
        if let value { current.values[fieldId] = value } else { current.values.removeValue(forKey: fieldId) }
        draft = current
        editFailure = nil
        error = nil
        let previous = editTask
        editTask = Task { @MainActor in
            await previous?.value
            guard !Task.isCancelled else { return }
            do {
                let saved = try await actions.setValue(scope, descriptor, fieldId, value)
                guard sequence == editSequence else { return }
                draft = saved
                editFailure = nil
            } catch {
                guard sequence == editSequence else { return }
                editFailure = "That answer could not be saved securely. Try again before sending."
                self.error = editFailure
            }
        }
    }

    private func flushEdits() async throws -> CardFormDraft {
        await editTask?.value
        guard editFailure == nil, let draft else { throw CardFormDraftError.submissionPending }
        return draft
    }

    private func reviewInMessage() async {
        guard let scope else { return }
        do {
            let current = try await flushEdits()
            guard let message = Self.composerText(form: descriptor, draft: current) else {
                self.error = "This review is too long for one message. Shorten an answer and try again."
                return
            }
            actions.attachToMessage(scope, descriptor, message)
        } catch {
            self.error = "Wait for the latest answers to save before reviewing this message."
        }
    }

    private static func composerText(form: CardFormDescriptor, draft: CardFormDraft) -> String? {
        var lines = [form.title]
        for field in form.fields {
            let display: String
            switch draft.values[field.id] {
            case let .text(value), let .date(value): display = value
            case let .choice(value): display = field.options?.first(where: { $0.id == value })?.label ?? "Not provided"
            case let .boolean(value): display = value ? "Yes" : "No"
            case nil: display = "Not provided"
            }
            lines.append("\(field.label): \(display)")
        }
        let text = lines.joined(separator: "\n")
        guard text.utf16.count <= 4_000 else { return nil }
        return text
    }

    private func reviewRevision(carry: Bool) async {
        guard let scope else { return }
        do {
            _ = try await flushEdits()
            draft = try await actions.review(scope, descriptor, carry)
            error = nil
        } catch {
            self.error = "The updated form could not be saved securely. Try again."
        }
    }

    @ViewBuilder
    private func activeFormTask(_ pointer: CardFormActiveTaskPointer, draft current: CardFormDraft) -> some View {
        let status = actions.taskStatus(pointer.taskId) ?? pointer.taskStatus
        VStack(alignment: .leading, spacing: 7) {
            Text("Another form request is active.")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
            Text(SuggestionTaskReceipt.detail(for: status))
                .font(.subheadline)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
            if ["done", "failed", "cancelled"].contains(status), current.pendingReview == nil,
               !current.requiresFreshRevision, let scope {
                Button("Review form again") { startNextEntry(scope, taskId: pointer.taskId) }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                    .accessibilityHint("Opens fresh answers in the message box. Nothing is sent until you press Send.")
            } else if ["waiting_approval", "waiting_budget", "needs_attention"].contains(status) {
                Text("You can reply in chat while this request waits. The form stays unsent until you review and send it again.")
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }


    private func startNextEntry(_ scope: CardFormScope, taskId: String) {
        Task { @MainActor in
            do {
                let next = try await actions.startNextEntry(scope, taskId)
                draft = next
                error = nil
                guard let message = Self.composerText(form: descriptor, draft: next) else {
                    self.error = "This review is too long for one message. Shorten an answer and try again."
                    return
                }
                actions.attachToMessage(scope, descriptor, message)
            } catch {
                self.error = "This form is still tied to the previous task. Refresh its status and try again."
            }
        }
    }

    private func resumeEditing(scope: CardFormScope) async {
        do {
            draft = try await actions.resumeRejected(scope)
            error = nil
        } catch {
            self.error = "This request is still being reconciled. Retry it or refresh the card."
        }
    }

    private func rejectionText(_ code: String) -> String {
        code == "stale_revision"
            ? "This card changed. Refresh it and review the updated form before sending."
            : "The form was not accepted. Review it before trying again."
    }
}
