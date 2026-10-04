import SwiftUI

struct ApprovalsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var decisionInFlightID: String?
    @State private var decisionSuccessFeedback = 0
    @State private var decisionErrorFeedback = 0
    @State private var editingApproval: PendingApproval?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if model.overview == nil {
                    AssistantLoadingState(title: "Loading approvals…")
                } else if pending.isEmpty {
                    AssistantEmptyState(
                        "All clear",
                        systemImage: "checkmark.shield",
                        description: "The assistant asks here before an action leaves its workspace."
                    )
                } else {
                    approvalSummary
                    Text("Review the real-world effect first. Approving resumes the parked task immediately.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    ForEach(pending) { item in approvalCard(item) }
                }

                if !resolved.isEmpty {
                    DisclosureGroup("Recently resolved") {
                        VStack(spacing: 0) {
                            ForEach(resolved) { item in
                                resolvedRow(item)
                                .padding(.vertical, 11)
                                if item.id != resolved.last?.id { Divider() }
                            }
                        }
                        .padding(.top, 6)
                    }
                    .font(.subheadline.weight(.semibold))
                    .assistantPanel(in: colorScheme)
                }
            }
            .padding(16)
            .padding(.bottom, 28)
            .frame(maxWidth: isLandscape ? 760 : .infinity, alignment: .leading)
        }
        .navigationTitle("Approvals")
        .assistantSubmenuChrome()
        .refreshable { await model.refreshAll() }
        .task { if model.overview == nil { await model.refreshOverview() } }
        .sensoryFeedback(.success, trigger: decisionSuccessFeedback)
        .sensoryFeedback(.error, trigger: decisionErrorFeedback)
        .sheet(item: $editingApproval) { item in
            NavigationStack { ApprovalPayloadEditor(item: item) }
        }
    }

    private var pending: [PendingApproval] { model.overview?.approvals.pending ?? [] }
    private var resolved: [ResolvedApproval] { model.overview?.approvals.resolved ?? [] }
    private var approvalSummary: some View {
        HStack(alignment: .top, spacing: 12) {
            AssistantGlyph(
                systemName: pending.isEmpty ? "checkmark.shield.fill" : "hand.raised.fill",
                tint: pending.isEmpty ? AssistantTheme.success(for: colorScheme) : AssistantTheme.warning(for: colorScheme)
            )
            VStack(alignment: .leading, spacing: 4) {
                Text(pending.isEmpty ? "All clear" : "Your attention is needed")
                    .font(.headline)
                Text(
                    pending.isEmpty
                        ? "No actions are waiting for a decision."
                        : "\(pending.count) \(pending.count == 1 ? "action is" : "actions are") parked until you decide."
                )
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .assistantPanel(in: colorScheme)
    }

    private func approvalCard(_ item: PendingApproval) -> some View {
        Group {
            if isLandscape {
                HStack(alignment: .top, spacing: 20) {
                    approvalDetails(item)
                    Divider()
                        .overlay(AssistantTheme.warning(for: colorScheme).opacity(0.18))
                    VStack(alignment: .leading, spacing: 9) {
                        approvalActions(item)
                    }
                    .frame(width: 190)
                }
            } else {
                VStack(alignment: .leading, spacing: 14) {
                    approvalDetails(item)
                    Group {
                        if usesAccessibilityLayout {
                            VStack(spacing: 9) { approvalActions(item) }
                        } else {
                            AssistantFlowLayout(spacing: 9) { approvalActions(item) }
                        }
                    }
                }
            }
        }
        .assistantCard(
            in: colorScheme,
            surface: AssistantTheme.warningSurface(for: colorScheme),
            strokeTint: AssistantTheme.warning(for: colorScheme)
        )
    }

    private func approvalDetails(_ item: PendingApproval) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            approvalHeader(item)
            Text(item.approval.summary)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Divider()
                .overlay(AssistantTheme.warning(for: colorScheme).opacity(0.18))
            approvalMetadata(item)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func approvalHeader(_ item: PendingApproval) -> some View {
        let tool = HStack(spacing: 10) {
            AssistantGlyph(systemName: "checkmark.shield.fill", tint: AssistantTheme.warning(for: colorScheme))
            VStack(alignment: .leading, spacing: 3) {
                Text("Approval needed")
                    .font(.caption.weight(.bold))
                    .textCase(.uppercase)
                    .tracking(0.65)
                    .foregroundStyle(AssistantTheme.warningInk(for: colorScheme))
                Text(item.toolName.sentenceCaseIdentifier)
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.warningInk(for: colorScheme).opacity(0.74))
            }
        }

        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 10) {
                tool
                approvalCode(item)
            }
        } else {
            HStack {
                tool
                Spacer()
                approvalCode(item)
            }
        }
    }

    private func approvalCode(_ item: PendingApproval) -> some View {
        // One fixed-height slot holding both states. The spinner used to be
        // 44pt tall against the badge's ~26, so confirming a decision grew the
        // card header by 18pt and snapped it back — on the most consequential
        // screen in the app.
        ZStack {
            if decisionInFlightID == item.id {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Applying decision")
            } else {
                Text(item.approval.shortCode)
                    .font(.caption.monospaced().weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 7)
                    .background(
                        AssistantTheme.warning(for: colorScheme).opacity(0.12),
                        in: Capsule()
                    )
            }
        }
        .frame(minHeight: 28)
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.18),
            value: decisionInFlightID
        )
    }

    @ViewBuilder
    private func approvalMetadata(_ item: PendingApproval) -> some View {
        let labels = [
            (item.taskType.sentenceCaseIdentifier, "square.stack.3d.up"),
            (item.taskTrust.sentenceCaseIdentifier, "person.crop.circle"),
        ]
        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(labels, id: \.0) { label in
                    Label(label.0, systemImage: label.1)
                }
                Text("Requested \(relative(item.approval.requestedAt))")
            }
            .font(.caption)
            .foregroundStyle(AssistantTheme.warningInk(for: colorScheme).opacity(0.78))
        } else {
            VStack(alignment: .leading, spacing: 6) {
                AssistantFlowLayout(spacing: 6) {
                    ForEach(labels, id: \.0) { label in
                        Label(label.0, systemImage: label.1)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 7)
                            .background(AssistantTheme.warning(for: colorScheme).opacity(0.1), in: Capsule())
                    }
                }
                Text("Requested \(relative(item.approval.requestedAt))")
            }
            .font(.caption)
            .foregroundStyle(AssistantTheme.warningInk(for: colorScheme).opacity(0.78))
        }
    }

    /// One-time decisions keep their two-tap confirmation. Saved permissions
    /// open a review that describes exactly which future actions they cover.
    @ViewBuilder
    private func approvalActions(_ item: PendingApproval) -> some View {
        approvalActionButton(
            "Approve",
            confirmationTitle: "Approve?",
            systemImage: "checkmark",
            decision: "approved",
            kind: .primary,
            hint: "Approves this request and resumes the task.",
            item: item
        )

        approvalActionButton(
            "Deny",
            confirmationTitle: "Deny?",
            systemImage: "xmark",
            decision: "denied",
            kind: .neutral,
            hint: "Stops this action.",
            item: item
        )

        if let scope = item.rememberLabel {
            AssistantAlwaysApproveButton(scope: scope) {
                guard decisionInFlightID == nil else { return }
                decisionInFlightID = item.id
                let succeeded = await model.approveAndRemember(item)
                decisionInFlightID = nil
                if succeeded { decisionSuccessFeedback += 1 }
                else { decisionErrorFeedback += 1 }
            }
            .disabled(decisionInFlightID != nil)
            .accessibilityIdentifier("assistant.approvals.\(item.id).alwaysApprove")
        }

        Menu {
            Button("Edit request", systemImage: "pencil") {
                editingApproval = item
            }
        } label: {
            Label("More", systemImage: "ellipsis.circle")
                .font(.subheadline.weight(.medium))
        }
        .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
        .controlSize(.small)
        .disabled(decisionInFlightID != nil)
    }

    private func approvalActionButton(
        _ title: String,
        confirmationTitle: String,
        systemImage: String,
        decision: String,
        kind: AssistantActionButtonKind,
        hint: String,
        item: PendingApproval
    ) -> some View {
        AssistantConfirmationButton(title, confirmationTitle: confirmationTitle, systemImage: systemImage,
            kind: kind, hint: hint, compact: true) {
            applyDecision(item, decision: decision)
        }
        .disabled(decisionInFlightID != nil)
        .accessibilityIdentifier("assistant.approvals.\(item.id).\(decision)")
    }

    private func applyDecision(_ item: PendingApproval, decision: String) {
        guard decisionInFlightID == nil else { return }
        decisionInFlightID = item.id
        Task {
            let succeeded = await model.decide(item, decision: decision)
            decisionInFlightID = nil
            if succeeded {
                decisionSuccessFeedback += 1
            } else {
                decisionErrorFeedback += 1
            }
        }
    }

    @ViewBuilder
    private func resolvedRow(_ item: ResolvedApproval) -> some View {
        let detail = VStack(alignment: .leading, spacing: 4) {
            Text(item.approval.summary)
                .font(.subheadline)
                .lineLimit(usesAccessibilityLayout ? nil : 2)
            Text("\(item.approval.shortCode) · \(relative(item.approval.resolvedAt ?? item.approval.expiresAt))\(item.approval.edited == true ? " · edited" : "")")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
        }

        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 9) {
                detail
                StatusPill(status: item.approval.status)
            }
        } else {
            HStack(alignment: .top) {
                detail
                Spacer()
                StatusPill(status: item.approval.status)
            }
        }
    }

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }
    private var isLandscape: Bool { verticalSizeClass == .compact }
}

private struct ApprovalPayloadEditor: View {
    let item: PendingApproval

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var payload: String
    @State private var error: String?
    @State private var isSaving = false

    init(item: PendingApproval) {
        self.item = item
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = (try? encoder.encode(item.approval.payload)) ?? Data("{}".utf8)
        _payload = State(initialValue: String(decoding: data, as: UTF8.self))
    }

    var body: some View {
        AssistantForm {
            Section {
                TextEditor(text: $payload)
                    .font(.system(.caption, design: .monospaced))
                    .frame(minHeight: 260)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("Exact request")
            } footer: {
                Text("The assistant uses this JSON payload after approval.")
            }
            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Edit request")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Approving…" : "Approve") { approve() }
                    .disabled(isSaving)
            }
        }
    }

    private func approve() {
        guard let data = payload.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(JSONValue.self, from: data),
              case .object = decoded else {
            error = "Payload must be a valid JSON object."
            return
        }
        error = nil
        isSaving = true
        Task {
            let succeeded = await model.editAndApprove(item, payload: decoded)
            isSaving = false
            if succeeded { dismiss() }
        }
    }
}

#if DEBUG
extension ApprovalsView {
    @MainActor static func visualReviewEditor(_ item: PendingApproval) -> AnyView { AnyView(ApprovalPayloadEditor(item: item)) }
}
#endif
