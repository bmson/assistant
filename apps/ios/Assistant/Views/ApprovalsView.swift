import SwiftUI

struct ApprovalsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
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
            if item.ownerNumberGrantAvailable == true {
                OwnerCallNumberPermissionReview(approvalID: item.id, source: item.approval.payload, sourceFingerprint: item.ownerCallSourceFingerprint, connectionRevision: model.activityConnectionRevision)
                    .id(OwnerCallReviewSourceIdentity(approvalID: item.id, source: item.approval.payload, sourceFingerprint: item.ownerCallSourceFingerprint, connectionRevision: model.activityConnectionRevision))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func approvalHeader(_ item: PendingApproval) -> some View {
        ApprovalRequestHeader(
            toolName: item.toolName.sentenceCaseIdentifier,
            shortCode: item.approval.shortCode,
            isApplying: decisionInFlightID == item.id,
            usesAccessibilityLayout: usesAccessibilityLayout
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


/// Exact current-model origin, also used as the SwiftUI subtree identity.
struct OwnerCallReviewSourceIdentity: Hashable {
    let approvalID: String
    let source: JSONValue
    let sourceFingerprint: String?
    let connectionRevision: Int
}

/// A reference lease survives value-type View copies. Every asynchronous publication
/// additionally checks the current model, so retirement does not wait for onChange.
@MainActor
final class OwnerCallReviewPublicationLease {
    struct Operation: Equatable {
        let nonce: UUID
        let source: OwnerCallReviewSourceIdentity
        let validityChoice: String
    }
    private var active: Operation?
    func begin(source: OwnerCallReviewSourceIdentity, validityChoice: String) -> Operation {
        let operation = Operation(nonce: UUID(), source: source, validityChoice: validityChoice)
        active = operation
        return operation
    }
    func invalidate() { active = nil }
    @discardableResult
    func publish(_ operation: Operation, currentSource: () -> Bool, changes: () -> Void) -> Bool {
        guard active == operation, currentSource() else { return false }
        changes()
        return true
    }
}

private struct OwnerCallNumberPermissionReview: View {
    let approvalID: String
    let source: JSONValue
    let sourceFingerprint: String?
    let connectionRevision: Int
    @Environment(AppModel.self) private var model
    @State private var validityChoice = "7d"
    @State private var preview: OwnerCallNumberGrantPreview?
    @State private var acknowledged = false
    @State private var working = false
    @State private var saved = false
    @State private var publicationLease = OwnerCallReviewPublicationLease()
    @State private var error: String?
#if DEBUG
    private var fixtureMode = false
#endif

    init(approvalID: String, source: JSONValue, sourceFingerprint: String?, connectionRevision: Int) {
        self.approvalID = approvalID; self.source = source; self.sourceFingerprint = sourceFingerprint; self.connectionRevision = connectionRevision
    }

#if DEBUG
    init(fixtureStage: String, preview: OwnerCallNumberGrantPreview) {
        self.approvalID = preview.approvalId; self.source = .object([:]); self.sourceFingerprint = "fixture-source"
        self.fixtureMode = true
        self.connectionRevision = 0
        _preview = State(initialValue: ["review", "other-active"].contains(fixtureStage) ? preview : nil)
        _acknowledged = State(initialValue: fixtureStage == "other-active")
        _saved = State(initialValue: fixtureStage == "saved")
        _error = State(initialValue: fixtureStage == "ambiguous" ? "Could not confirm result. Refresh to check this call and saved permission before trying again." : nil)
    }
#endif

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Permission for future calls").font(.headline)
            if saved {
                Text("This call is approved, not yet completed. Future permission is saved.")
            } else {
                Text("This new permission is not created until you approve. This also approves the current call.")
                    .font(.subheadline).foregroundStyle(.secondary)
                Picker("Permission duration", selection: $validityChoice) {
                    Text("24 hours").tag("24h")
                    Text("7 days").tag("7d")
                    Text("30 days").tag("30d")
                }
                .pickerStyle(.menu).frame(minHeight: 44)
                .disabled(working)
                Button { review() } label: {
                    Text(working ? "Preparing review…" : "Review future permission").frame(maxWidth: .infinity, minHeight: 44).fixedSize(horizontal: false, vertical: true)
                }.buttonStyle(.bordered).disabled(working)
                if let preview {
                    Text("Future permission").font(.headline)
                    field("Exact number", preview.grant.recipientE164)
                    Text("Simple requests such as “Call me now” or a call to this exact number may use this permission. Requests that add a topic, script, or other instructions require approval for that call. For “me”, “my phone”, or “my number”, your configured owner number must match this permission. A name alone still needs approval. Routing to this number does not verify who answers.")
                    Text("Any topic or script when you directly ask for a call; anyone who answers. Future calls can use different topics, scripts and personal information from available context, including saved or retrieved information. We do not verify who controls this number or who answers.")
                    Text("Up to \(preview.grant.maxMinutes) requested minutes per call. Configured system maximum: \(preview.configuredMaxMinutes) minutes. Existing rate and budget limits apply; this permission adds no call quota.")
                    if !preview.existingActiveGrants.isEmpty {
                        Text("Other permissions remain active. This adds a permission; it does not replace or narrow them.").fontWeight(.semibold)
                        ForEach(preview.existingActiveGrants) { existing in
                            Text("\(existing.match.recipientE164) · any topic or script when you directly ask for a call · anyone may answer · requested duration ceiling \(existing.match.maxMinutes) minutes · expires \(expiry(existing.match.expiresAt, zone: preview.ownerTimeZone))")
                        }
                    }
                    field("Permission expires", expiry(preview.grant.expiresAt, zone: preview.ownerTimeZone))
                    Text("Expiry stops new authorizations. A call already in flight may continue. Pause or delete each saved permission separately. A paused permission requires a fresh review from a pending owner call.")
                    Text("This call’s instructions").font(.headline)
                    Text("Instructions to the voice assistant are not guarantees of what it will say or agree to. Future calls do not have to repeat this brief.")
                    field("Goal", preview.brief.goal)
                    field("Contact label", preview.brief.contactName)
                    field("Context it may share", preview.brief.context)
                    field("What it may agree to", preview.brief.mayAgreeTo)
                    field("What it must not do", preview.brief.mustNot)
                    field("Language", preview.brief.language)
                    field("Voicemail behavior", preview.brief.onVoicemail == "leave_message" ? "Leave a message" : "Hang up")
                    field(preview.brief.onVoicemail == "hang_up" ? "Saved voicemail message (not used when hanging up)" : "Voicemail message", preview.brief.voicemailMessage)
                    Text("The provider allows a 20-second introduction buffer beyond the configured maximum. Ending is asynchronous; this is not a precise hang-up guarantee. Approved does not mean completed.")
                    field("Review expires", expiry(preview.reviewExpiresAt, zone: preview.ownerTimeZone))
                    Toggle("I understand this permits future calls to this exact number about any topic or script when you directly ask for a call, may share personal information from available context including saved or retrieved information, and anyone may answer.", isOn: $acknowledged)
                        .toggleStyle(.switch).frame(minHeight: 44).disabled(working)
                    Button { approve(preview) } label: {
                        Text(working ? "Saving permission…" : "Approve this call and future permission")
                            .multilineTextAlignment(.center).frame(maxWidth: .infinity, minHeight: 48).fixedSize(horizontal: false, vertical: true)
                    }.buttonStyle(.borderedProminent).disabled(!acknowledged || working)
                    Button { resetReview() } label: {
                        Text("Cancel review").frame(maxWidth: .infinity, minHeight: 44).fixedSize(horizontal: false, vertical: true)
                    }.buttonStyle(.bordered).disabled(working)
                }
                if let error { Text(error).foregroundStyle(.red).accessibilityAddTraits(.updatesFrequently) }
            }
        }
        .font(.subheadline)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onDisappear { resetReview() }
        .onChange(of: model.activityConnectionRevision) { _, _ in resetReview(); error = "This review expired or changed. Review again." }
        .onChange(of: validityChoice) { _, _ in resetReview() }
        .onChange(of: sourceFingerprint) { _, _ in resetReview(); error = "This review expired or changed. Review again." }
        .onChange(of: source) { _, _ in resetReview(); error = "This review expired or changed. Review again." }
        .task(id: preview?.reviewToken) {
            guard let preview, let deadline = date(preview.reviewExpiresAt) else { return }
            let seconds = deadline.timeIntervalSinceNow
            if seconds > 0 { try? await Task.sleep(for: .seconds(seconds)) }
            guard !Task.isCancelled else { return }
            resetReview()
            error = "This review expired or changed. Review again."
        }
    }

    private func field(_ title: String, _ value: String?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption.weight(.semibold))
            Text((value?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 } ?? "Not specified")
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func date(_ value: String) -> Date? {
        ISO8601DateFormatter.assistant.date(from: value) ?? AssistantFormatters.internetDateTime.date(from: value)
    }

    private func expiry(_ value: String, zone: String) -> String {
        guard let date = date(value) else { return value + " (UTC)" }
        let formatter = DateFormatter()
        formatter.timeZone = TimeZone(identifier: zone) ?? .gmt
        formatter.dateStyle = .long
        formatter.timeStyle = .short
        return formatter.string(from: date) + " (" + zone + ")"
    }

    private var currentSourceIdentity: OwnerCallReviewSourceIdentity {
        OwnerCallReviewSourceIdentity(approvalID: approvalID, source: source, sourceFingerprint: sourceFingerprint, connectionRevision: connectionRevision)
    }
    private func resetReview() { publicationLease.invalidate(); preview = nil; acknowledged = false; working = false; error = nil }
    @discardableResult
    private func publish(_ operation: OwnerCallReviewPublicationLease.Operation, changes: () -> Void) -> Bool {
        publicationLease.publish(operation, currentSource: { model.ownerCallReviewSourceIsCurrent(operation.source) }, changes: changes)
    }

    private func review() {
#if DEBUG
        guard !fixtureMode else { return }
#endif
        resetReview()
        let operation = publicationLease.begin(source: currentSourceIdentity, validityChoice: validityChoice)
        guard publish(operation, changes: { working = true }) else { return }
        Task {
            do {
                let prepared = try await model.previewOwnerCallNumberGrant(id: operation.source.approvalID, validityChoice: operation.validityChoice)
                guard !Task.isCancelled else { return }
                publish(operation) {
                    if prepared.approvalId == operation.source.approvalID { preview = prepared }
                    else { error = "This review expired or changed. Review again." }
                    working = false
                }
            } catch {
                guard !Task.isCancelled else { return }
                publish(operation) {
                    error = "This review expired or changed. Review again."
                    working = false
                }
            }
        }
    }

    private func approve(_ review: OwnerCallNumberGrantPreview) {
#if DEBUG
        guard !fixtureMode else { return }
#endif
        guard acknowledged, let deadline = date(review.reviewExpiresAt), deadline > Date() else {
            resetReview(); error = "This review expired or changed. Review again."; return
        }
        let operation = publicationLease.begin(source: currentSourceIdentity, validityChoice: validityChoice)
        guard publish(operation, changes: { working = true }) else { return }
        Task {
            let failure = await model.approveOwnerCallNumberGrant(id: operation.source.approvalID, reviewToken: review.reviewToken)
            guard !Task.isCancelled else { return }
            publish(operation) {
                resetReview()
                if let failure { error = failure } else { saved = true }
            }
        }
    }
}


#if DEBUG
extension ApprovalsView {
    /// Real review surface, isolated seed state. No fixture control can submit a mutation.
    @MainActor static func visualReviewOwnerCallPermission(_ stage: String) -> AnyView {
        let grant = OwnerCallNumberGrant(schemaVersion: 1, grantId: "11111111-1111-4111-8111-111111111111", recipientE164: "+14155550123", maxMinutes: 12, expiresAt: "2099-10-30T12:00:00.000Z")
        let brief = OwnerCallNumberBrief(to: grant.recipientE164, contactName: "A deliberately long contact label for a narrow-screen review", goal: "Ask about the appointment and carefully confirm the details before making any commitment.", context: "The assistant may use personal information already available in context. This long fixture checks full wrapping without collapsing the reviewed scope.", mayAgreeTo: "Confirm the requested appointment time.", mustNot: "Do not agree to payments or a different appointment.", maxMinutes: 12, onVoicemail: "hang_up", voicemailMessage: "Retained message; not used when hanging up.", language: "English")
        var preview = OwnerCallNumberGrantPreview(ok: true, reviewToken: "fixture-no-authority", approvalId: "22222222-2222-4222-8222-222222222222", brief: brief, grant: grant, reviewExpiresAt: "2099-10-23T12:10:00.000Z", ownerTimeZone: "America/Los_Angeles", configuredMaxMinutes: 15)
        if stage == "other-active" { preview.existingActiveGrants = [.init(policyId: "older-permission", match: grant)] }
        return AnyView(ScrollView {
            OwnerCallNumberPermissionReview(fixtureStage: stage, preview: preview).padding(16)
        }.navigationTitle("Review phone permission"))
    }
}
#endif
