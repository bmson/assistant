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
                            ForEach(Array(resolved.prefix(20))) { item in
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

        VStack(alignment: .leading, spacing: 9) {
            if usesAccessibilityLayout {
                detail
                StatusPill(status: item.approval.status)
            } else {
                HStack(alignment: .top) {
                    detail
                    Spacer()
                    StatusPill(status: item.approval.status)
                }
            }
            if item.toolName == "phone.call" {
                OwnerCallGrantRecoveryControl(approvalID: item.id)
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

struct OwnerCallReviewLimitsIdentity: Equatable {
    let maxCallsPerHour: Int
    let maxCallsPerDay: Int
    let maxCostUsdMicrosPerCall: Int
    let maxCostUsdMicrosPerDay: Int

    init(_ limits: OwnerCallGrantLimits) {
        maxCallsPerHour = limits.maxCallsPerHour
        maxCallsPerDay = limits.maxCallsPerDay
        maxCostUsdMicrosPerCall = limits.maxCostUsdMicrosPerCall
        maxCostUsdMicrosPerDay = limits.maxCostUsdMicrosPerDay
    }
}

/// A reference lease survives value-type View copies. Every asynchronous publication
/// additionally checks the current model, so retirement does not wait for onChange.
@MainActor
final class OwnerCallReviewPublicationLease {
    struct Operation: Equatable {
        let nonce: UUID
        let source: OwnerCallReviewSourceIdentity
        let validityChoice: String
        let limits: OwnerCallReviewLimitsIdentity
    }
    private var active: Operation?
    func begin(source: OwnerCallReviewSourceIdentity, validityChoice: String, limits: OwnerCallGrantLimits = .defaults) -> Operation {
        let operation = Operation(nonce: UUID(), source: source, validityChoice: validityChoice, limits: OwnerCallReviewLimitsIdentity(limits))
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
    @State private var maxCallsPerHour = OwnerCallGrantLimits.defaults.maxCallsPerHour
    @State private var maxCallsPerDay = OwnerCallGrantLimits.defaults.maxCallsPerDay
    @State private var maxCostUsdMicrosPerCall = OwnerCallGrantLimits.defaults.maxCostUsdMicrosPerCall
    @State private var maxCostUsdMicrosPerDay = OwnerCallGrantLimits.defaults.maxCostUsdMicrosPerDay
    @State private var preview: OwnerCallNumberGrantPreview?
    @State private var acknowledged = false
    @State private var working = false
    @State private var checking = false
    @State private var closing = false
    @State private var saved = false
    @State private var initialCheckComplete = false
    @State private var operationWasRegistered = false
    @State private var operationNeedsCheck = false
    @State private var operationStatus: OwnerCallGrantOperationStatus?
    @State private var showingCloseConfirmation = false
    @State private var publicationLease = OwnerCallReviewPublicationLease()
    @State private var error: String?
#if DEBUG
    private var fixtureMode = false
#endif

    init(approvalID: String, source: JSONValue, sourceFingerprint: String?, connectionRevision: Int) {
        self.approvalID = approvalID
        self.source = source
        self.sourceFingerprint = sourceFingerprint
        self.connectionRevision = connectionRevision
    }

#if DEBUG
    init(fixtureStage: String, preview: OwnerCallNumberGrantPreview) {
        self.approvalID = preview.approvalId
        self.source = .object([:])
        self.sourceFingerprint = "fixture-source"
        self.fixtureMode = true
        self.connectionRevision = 0
        _preview = State(initialValue: ["review", "other-active"].contains(fixtureStage) ? preview : nil)
        _acknowledged = State(initialValue: fixtureStage == "other-active")
        _saved = State(initialValue: fixtureStage == "saved")
        _operationWasRegistered = State(initialValue: ["review", "other-active", "ambiguous"].contains(fixtureStage))
        _initialCheckComplete = State(initialValue: true)
        _operationNeedsCheck = State(initialValue: fixtureStage == "ambiguous")
        _error = State(initialValue: fixtureStage == "ambiguous" ? "The result is not confirmed. Check this permission operation before reviewing again." : nil)
    }
#endif

    private var selectedLimits: OwnerCallGrantLimits {
        OwnerCallGrantLimits(
            maxCallsPerHour: maxCallsPerHour,
            maxCallsPerDay: maxCallsPerDay,
            maxCostUsdMicrosPerCall: maxCostUsdMicrosPerCall,
            maxCostUsdMicrosPerDay: maxCostUsdMicrosPerDay
        )
    }

    private var hasLiveReview: Bool {
        guard let preview else { return false }
        return isSupportedPreview(preview) && date(preview.reviewExpiresAt).map { $0 > Date() } == true
    }

    private var canStartReview: Bool {
        guard initialCheckComplete, !working, !checking, !closing,
              !operationWasRegistered, !operationNeedsCheck,
              let operationStatus, operationStatus.ok,
              let status = operationStatus.status else { return false }
        return ["none", "closed_no_effect", "rejected_no_effect"].contains(status)
    }

    private var closeToken: String? {
        guard let operationStatus, operationStatus.ok,
              ["registered", "admitted"].contains(operationStatus.status ?? "") else { return nil }
        return operationStatus.closeToken
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Future call permission")
                .font(.headline)
            Text("This permission applies to direct requests to call this number. It also approves the current call when you save it.")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            if saved {
                Label("Permission saved. Current availability has not been checked.", systemImage: "checkmark.seal.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
            } else if let preview {
                permissionPreview(preview)
            } else if !initialCheckComplete {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Checking for an existing permission review…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            } else if canStartReview {
                limitEditor
                Picker("Permission duration", selection: $validityChoice) {
                    Text("24 hours").tag("24h")
                    Text("7 days").tag("7d")
                    Text("30 days").tag("30d")
                }
                .pickerStyle(.menu)
                .frame(minHeight: 44)
                .disabled(working || checking || closing)

                Button { review() } label: {
                    Text(working ? "Preparing review…" : "Review a future permission")
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .buttonStyle(.bordered)
                .disabled(working || checking || closing)
            } else {
                operationRecoveryPanel
            }

            if working || checking || closing {
                ProgressView(working ? "Preparing permission…" : checking ? "Checking permission operation…" : "Closing permission review…")
                    .font(.caption)
            }
            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .font(.subheadline)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .confirmationDialog(
            "Close this permission review?",
            isPresented: $showingCloseConfirmation,
            titleVisibility: .visible
        ) {
            Button("Close permission review", role: .destructive) { closeOperation() }
            Button("Keep review open", role: .cancel) {}
        } message: {
            Text("This closes only the permission review. If saving completed first, the permission stays saved. Closing does not deny or cancel this call and does not change other permissions.")
        }
        .onDisappear { publicationLease.invalidate() }
        .onChange(of: model.activityConnectionRevision) { _, _ in retireForSourceChange() }
        .onChange(of: sourceFingerprint) { _, _ in retireForSourceChange() }
        .onChange(of: source) { _, _ in retireForSourceChange() }
        .task(id: currentSourceIdentity) {
#if DEBUG
            guard !fixtureMode else { return }
#endif
            operationStatus = nil
            initialCheckComplete = false
            operationWasRegistered = false
            operationNeedsCheck = false
            checkOperation()
        }
        .task(id: preview?.reviewToken) {
            guard let preview, let deadline = date(preview.reviewExpiresAt) else { return }
            let seconds = deadline.timeIntervalSinceNow
            if seconds > 0 { try? await Task.sleep(for: .seconds(seconds)) }
            guard !Task.isCancelled else { return }
            retireExpiredReview()
        }
    }

    private var limitEditor: some View {
        DisclosureGroup("Call limits") {
            VStack(alignment: .leading, spacing: 8) {
                Stepper(value: Binding(
                    get: { maxCallsPerHour },
                    set: { value in
                        maxCallsPerHour = value
                        maxCallsPerDay = max(maxCallsPerDay, value)
                    }
                ), in: 1...100) {
                    Text("Calls per hour · \(maxCallsPerHour)")
                }
                Stepper(value: Binding(
                    get: { maxCallsPerDay },
                    set: { value in
                        maxCallsPerDay = value
                        maxCallsPerHour = min(maxCallsPerHour, value)
                    }
                ), in: 1...100) {
                    Text("Calls per day · \(maxCallsPerDay)")
                }
                Stepper(value: Binding(
                    get: { maxCostUsdMicrosPerCall },
                    set: { value in
                        maxCostUsdMicrosPerCall = value
                        maxCostUsdMicrosPerDay = max(maxCostUsdMicrosPerDay, value)
                    }
                ), in: 100_000...100_000_000, step: 100_000) {
                    Text("Cost per call · \(money(maxCostUsdMicrosPerCall))")
                }
                Stepper(value: Binding(
                    get: { maxCostUsdMicrosPerDay },
                    set: { value in
                        maxCostUsdMicrosPerDay = value
                        maxCostUsdMicrosPerCall = min(maxCostUsdMicrosPerCall, value)
                    }
                ), in: 100_000...100_000_000, step: 100_000) {
                    Text("Cost per day · \(money(maxCostUsdMicrosPerDay))")
                }
            }
            .font(.caption)
            .padding(.top, 6)
        }
        .disabled(working || checking || closing || operationWasRegistered)
    }

    private func permissionPreview(_ review: OwnerCallNumberGrantPreview) -> some View {
        let grant = review.grant
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Call · \(grant.recipientE164)")
                    .font(.body.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Text("Review ready")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            Text("Up to \(grant.maxMinutes) min/call · \(grant.maxCallsPerHour ?? 0)/hour, \(grant.maxCallsPerDay ?? 0)/day · \(money(grant.maxCostUsdMicrosPerCall ?? 0))/call, \(money(grant.maxCostUsdMicrosPerDay ?? 0))/day")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("Only eligible direct requests from you to call this number, within these limits, can use this permission. Future eligible calls may cover different topics or use different scripts and may share personal information from available context. Anyone may answer.")
                .font(.caption)
                .foregroundStyle(.secondary)
            field("Permission expires", expiry(grant.expiresAt, zone: review.ownerTimeZone))

            DisclosureGroup("Permission details") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("A match to the saved number does not verify who controls it or who answers.")
                    Text("The saved prompt below describes the current call. It does not limit future calls covered by this permission.")
                    field("Current call goal", review.brief.goal)
                    field("Saved contact label", review.brief.contactName)
                    field("Context it may share", review.brief.context)
                    field("What it may agree to", review.brief.mayAgreeTo)
                    field("What it must not do", review.brief.mustNot)
                    field("Language", review.brief.language)
                    field("Voicemail behavior", review.brief.onVoicemail == "leave_message" ? "Leave a message" : "Hang up")
                    if review.brief.onVoicemail == "leave_message" {
                        field("Exact voicemail message", review.brief.voicemailMessage)
                    } else if let savedMessage = review.brief.voicemailMessage, !savedMessage.isEmpty {
                        field("Saved voicemail message (not used when hanging up)", savedMessage)
                    }
                    if !review.existingActiveGrants.isEmpty {
                        Text("Other permissions stay active and unchanged.")
                            .fontWeight(.semibold)
                        ForEach(review.existingActiveGrants) { existing in
                            Text("\(existing.match.recipientE164) · up to \(existing.match.maxMinutes) min/call · expires \(expiry(existing.match.expiresAt, zone: review.ownerTimeZone))")
                                .font(.caption)
                        }
                    }
                    Text("Expiry prevents new authorizations. A call already in flight may continue. Approved does not mean completed.")
                    field("Review expires", expiry(review.reviewExpiresAt, zone: review.ownerTimeZone))
                }
                .font(.caption)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 6)
            }
            .font(.subheadline.weight(.medium))

            Text("Reviewing saves the future permission and approves this current call together. If the result is uncertain, check the operation before trying again.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Toggle("I understand eligible direct requests from me may use this permission for different topics or scripts, may share personal information from available context, and anyone may answer, within the limits shown above.", isOn: $acknowledged)
                .toggleStyle(.switch)
                .frame(minHeight: 44)
                .disabled(working || checking || closing || !isSupportedPreview(review))
            Button { approve(review) } label: {
                Text(working ? "Saving permission…" : "Approve this call and save permission")
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!acknowledged || working || checking || closing || !isSupportedPreview(review) || !hasLiveReview)

            operationStatusPanel
            operationButtons
        }
    }

    private var operationRecoveryPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            operationStatusPanel
            if !initialCheckComplete {
                Text("Check the existing permission operation before starting another review.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            operationButtons
        }
    }

    private var operationStatusPanel: some View {
        Group {
            if let status = operationStatus, status.ok {
                Text(operationDescription(status))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if operationNeedsCheck {
                Text("The result is not confirmed. Check the permission operation before reviewing again.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private var operationButtons: some View {
        if !initialCheckComplete || operationWasRegistered || operationNeedsCheck || closeToken != nil {
            Button { checkOperation() } label: {
                Text(checking ? "Checking…" : "Check permission operation")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .disabled(working || checking || closing)
        }
        if closeToken != nil {
            Button("Close permission review") { showingCloseConfirmation = true }
                .frame(maxWidth: .infinity, minHeight: 44)
                .buttonStyle(.bordered)
                .disabled(working || checking || closing)
        }
    }

    private func operationDescription(_ status: OwnerCallGrantOperationStatus) -> String {
        switch status.status {
        case "none":
            return operationWasRegistered
                ? "No operation was found, but an earlier review may have registered. The outcome remains unconfirmed."
                : "No permission review is currently registered."
        case "registered": return "Permission review registered. It has not been confirmed as saved."
        case "admitted": return "Permission save is in progress. Check again; do not submit another review."
        case "committed": return "Permission saved. Current availability has not been checked."
        case "closed_no_effect": return "This permission review was closed without changing the call decision or other permissions."
        case "rejected_no_effect": return "This permission was not saved. The call decision and other permissions are unchanged."
        default: return "Permission operation status is unavailable. Check again before reviewing."
        }
    }

    private func isSupportedPreview(_ review: OwnerCallNumberGrantPreview) -> Bool {
        guard review.ok, review.approvalId == approvalID,
              review.grant.schemaVersion == 2, review.grant.action == "phone.call",
              let hourly = review.grant.maxCallsPerHour,
              let daily = review.grant.maxCallsPerDay,
              let perCall = review.grant.maxCostUsdMicrosPerCall,
              let perDay = review.grant.maxCostUsdMicrosPerDay else { return false }
        return hourly == selectedLimits.maxCallsPerHour
            && daily == selectedLimits.maxCallsPerDay
            && perCall == selectedLimits.maxCostUsdMicrosPerCall
            && perDay == selectedLimits.maxCostUsdMicrosPerDay
    }

    private func field(_ title: String, _ value: String?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption.weight(.semibold))
            Text((value?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 } ?? "Not specified")
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func money(_ micros: Int) -> String {
        String(format: "$%.2f", Double(micros) / 1_000_000)
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

    private func retireForSourceChange() {
        publicationLease.invalidate()
        preview = nil
        acknowledged = false
        working = false
        checking = false
        closing = false
        saved = false
        operationStatus = nil
        operationWasRegistered = false
        operationNeedsCheck = false
        initialCheckComplete = false
        error = "This review expired or changed. Check the permission operation before reviewing again."
    }

    private func retireExpiredReview() {
        publicationLease.invalidate()
        preview = nil
        acknowledged = false
        working = false
        operationWasRegistered = true
        operationNeedsCheck = true
        error = "This review expired. Check the permission operation to confirm whether it was saved."
    }

    @discardableResult
    private func publish(_ operation: OwnerCallReviewPublicationLease.Operation, changes: () -> Void) -> Bool {
        publicationLease.publish(operation, currentSource: { model.ownerCallReviewSourceIsCurrent(operation.source) }, changes: changes)
    }

    private func checkOperation() {
#if DEBUG
        guard !fixtureMode else { return }
#endif
        guard !checking, !working, !closing else { return }
        let operation = publicationLease.begin(source: currentSourceIdentity, validityChoice: validityChoice, limits: selectedLimits)
        checking = true
        error = nil
        Task {
            do {
                let result = try await model.checkOwnerCallGrantOperation(id: operation.source.approvalID)
                guard !Task.isCancelled else { return }
                publish(operation) {
                    checking = false
                    initialCheckComplete = true
                    operationStatus = result
                    if !result.ok {
                        operationNeedsCheck = true
                        error = "The result is not confirmed. Check this permission operation before reviewing again."
                    } else if result.status == "committed" {
                        saved = true
                        operationWasRegistered = false
                        operationNeedsCheck = false
                        preview = nil
                        acknowledged = false
                    } else if result.status == "closed_no_effect" || result.status == "rejected_no_effect" {
                        preview = nil
                        acknowledged = false
                        operationWasRegistered = false
                        operationNeedsCheck = false
                    } else if result.status == "none" {
                        if operationWasRegistered {
                            operationNeedsCheck = true
                            error = "No operation was found, but the earlier result is still unconfirmed. Check again or contact support."
                        } else {
                            operationNeedsCheck = false
                        }
                    } else if result.status == "registered" || result.status == "admitted" {
                        operationWasRegistered = true
                        operationNeedsCheck = false
                    } else if result.status == nil {
                        operationNeedsCheck = true
                        error = "The permission operation response was incomplete. Check again before reviewing."
                    } else {
                        operationNeedsCheck = true
                        error = "Permission operation status is unavailable. Check again before reviewing."
                    }
                }
            } catch {
                guard !Task.isCancelled else { return }
                publish(operation) {
                    checking = false
                    initialCheckComplete = true
                    operationNeedsCheck = true
                    self.error = "The result is not confirmed. Check this permission operation before reviewing again."
                }
            }
        }
    }

    private func review() {
#if DEBUG
        guard !fixtureMode else { return }
#endif
        guard canStartReview else { return }
        let operation = publicationLease.begin(source: currentSourceIdentity, validityChoice: validityChoice, limits: selectedLimits)
        guard publish(operation, changes: { working = true; error = nil }) else { return }
        Task {
            do {
                let prepared = try await model.previewOwnerCallNumberGrant(
                    id: operation.source.approvalID,
                    validityChoice: operation.validityChoice,
                    limits: selectedLimits
                )
                guard !Task.isCancelled else { return }
                publish(operation) {
                    working = false
                    operationWasRegistered = true
                    if prepared.ok && prepared.approvalId == operation.source.approvalID && isSupportedPreview(prepared) {
                        preview = prepared
                        operationNeedsCheck = false
                    } else {
                        preview = nil
                        acknowledged = false
                        operationNeedsCheck = true
                        error = "The permission review is registered, but its details could not be verified. Check the operation before continuing."
                    }
                }
            } catch {
                guard !Task.isCancelled else { return }
                publish(operation) {
                    working = false
                    operationWasRegistered = true
                    operationNeedsCheck = true
                    self.error = "The result is not confirmed. Check this permission operation before reviewing again."
                }
            }
        }
    }

    private func approve(_ review: OwnerCallNumberGrantPreview) {
#if DEBUG
        guard !fixtureMode else { return }
#endif
        guard acknowledged, hasLiveReview, isSupportedPreview(review), !working, !checking else {
            retireExpiredReview()
            return
        }
        let operation = publicationLease.begin(source: currentSourceIdentity, validityChoice: validityChoice, limits: selectedLimits)
        guard publish(operation, changes: { working = true; error = nil }) else { return }
        Task {
            let failure = await model.approveOwnerCallNumberGrant(id: operation.source.approvalID, reviewToken: review.reviewToken)
            guard !Task.isCancelled else { return }
            publish(operation) {
                working = false
                preview = nil
                acknowledged = false
                if failure == nil {
                    saved = true
                    operationWasRegistered = false
                    operationNeedsCheck = false
                } else {
                    operationWasRegistered = true
                    operationNeedsCheck = true
                    error = "The result is not confirmed. Check the permission operation before reviewing again."
                }
            }
        }
    }

    private func closeOperation() {
#if DEBUG
        guard !fixtureMode else { return }
#endif
        guard let token = closeToken, !closing, !working, !checking else { return }
        let operation = publicationLease.begin(source: currentSourceIdentity, validityChoice: validityChoice, limits: selectedLimits)
        guard publish(operation, changes: { closing = true; error = nil }) else { return }
        Task {
            do {
                let result = try await model.closeOwnerCallGrantOperation(id: operation.source.approvalID, closeToken: token)
                guard !Task.isCancelled else { return }
                publish(operation) {
                    closing = false
                    operationStatus = result
                    if result.ok && result.status == "committed" {
                        saved = true
                        preview = nil
                        acknowledged = false
                        operationWasRegistered = false
                        operationNeedsCheck = false
                    } else if result.ok && (result.status == "closed_no_effect" || result.status == "rejected_no_effect") {
                        preview = nil
                        acknowledged = false
                        operationWasRegistered = false
                        operationNeedsCheck = false
                    } else {
                        operationWasRegistered = true
                        operationNeedsCheck = true
                        error = "The result is not confirmed. Check this permission operation before reviewing again."
                    }
                }
            } catch {
                guard !Task.isCancelled else { return }
                publish(operation) {
                    closing = false
                    operationWasRegistered = true
                    operationNeedsCheck = true
                    self.error = "The result is not confirmed. Check this permission operation before reviewing again."
                }
            }
        }
    }
}

private struct OwnerCallGrantRecoveryControl: View {
    let approvalID: String
    @Environment(AppModel.self) private var model
    @State private var status: OwnerCallGrantOperationStatus?
    @State private var isChecking = false
    @State private var error: String?
    @State private var requestID = UUID()

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(isChecking ? "Checking…" : "Check permission status") { check() }
                .buttonStyle(.borderless)
                .disabled(isChecking)
            if let status, status.ok {
                Text(description(status))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onDisappear { requestID = UUID() }
    }

    private func description(_ status: OwnerCallGrantOperationStatus) -> String {
        switch status.status {
        case "committed": return "Permission saved. Current availability has not been checked."
        case "registered": return "A permission review was registered, but saving is not confirmed."
        case "admitted": return "Permission saving is in progress. Check again; do not submit another review."
        case "closed_no_effect": return "This permission review closed without changing the call decision or other permissions."
        case "rejected_no_effect": return "This permission was not saved. The call decision and other permissions are unchanged."
        case "none": return "No permission operation was found. If you expected a save, this result is inconclusive."
        default: return "Permission operation status is unavailable."
        }
    }

    private func check() {
        guard !isChecking else { return }
        let request = UUID()
        requestID = request
        isChecking = true
        error = nil
        Task {
            do {
                let result = try await model.checkOwnerCallGrantOperation(id: approvalID)
                guard !Task.isCancelled, requestID == request else { return }
                isChecking = false
                if result.ok { status = result }
                else { error = "The result is not confirmed. Check again before relying on it." }
            } catch {
                guard !Task.isCancelled, requestID == request else { return }
                isChecking = false
                self.error = "The result is not confirmed. Check again before relying on it."
            }
        }
    }
}


#if DEBUG
extension ApprovalsView {
    /// Real review surface, isolated seed state. No fixture control can submit a mutation.
    @MainActor static func visualReviewOwnerCallPermission(_ stage: String) -> AnyView {
        let defaults = OwnerCallGrantLimits.defaults
        let grant = OwnerCallNumberGrant(schemaVersion: 2, grantId: "11111111-1111-4111-8111-111111111111", recipientE164: "+14155550123", maxMinutes: 12, expiresAt: "2099-10-30T12:00:00.000Z", action: "phone.call", maxCallsPerHour: defaults.maxCallsPerHour, maxCallsPerDay: defaults.maxCallsPerDay, maxCostUsdMicrosPerCall: defaults.maxCostUsdMicrosPerCall, maxCostUsdMicrosPerDay: defaults.maxCostUsdMicrosPerDay)
        let brief = OwnerCallNumberBrief(to: grant.recipientE164, contactName: "A deliberately long contact label for a narrow-screen review", goal: "Ask about the appointment and carefully confirm the details before making any commitment.", context: "The assistant may use personal information already available in context. This long fixture checks full wrapping without collapsing the reviewed scope.", mayAgreeTo: "Confirm the requested appointment time.", mustNot: "Do not agree to payments or a different appointment.", maxMinutes: 12, onVoicemail: "hang_up", voicemailMessage: "Retained message; not used when hanging up.", language: "English")
        var preview = OwnerCallNumberGrantPreview(ok: true, reviewToken: "fixture-no-authority", approvalId: "22222222-2222-4222-8222-222222222222", brief: brief, grant: grant, reviewExpiresAt: "2099-10-23T12:10:00.000Z", ownerTimeZone: "America/Los_Angeles", configuredMaxMinutes: 15)
        if stage == "other-active" { preview.existingActiveGrants = [.init(policyId: "older-permission", match: grant)] }
        return AnyView(ScrollView {
            OwnerCallNumberPermissionReview(fixtureStage: stage, preview: preview).padding(16)
        }.navigationTitle("Review phone permission"))
    }
}
#endif
