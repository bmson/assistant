import SwiftUI
import XCTest
import CoreLocation
@testable import Assistant

extension APIModelsTests {
    func testCallCheckinDecodesExactRevisionAndLeavesLegacyRevisionUnknown() throws {
        let current = try JSONDecoder().decode(PhoneCallCheckin.self, from: Data(#"{"id":"c1","revision":3,"question":"Proceed?","answer":null}"#.utf8))
        let legacy = try JSONDecoder().decode(PhoneCallCheckin.self, from: Data(#"{"id":"c2","question":"Proceed?","answer":null}"#.utf8))
        XCTAssertEqual(current.revision, 3)
        XCTAssertNil(legacy.revision)
    }

    func testArchiveOldActivityProgressExposesDurableContinuation() throws {
        let progress = try JSONDecoder().decode(
            ArchiveOldActivityProgress.self,
            from: Data(#"{"ok":true,"operationId":"123e4567-e89b-12d3-a456-426614174000","scannedThisBatch":250,"archivedThisBatch":241,"scannedTotal":500,"archivedTotal":481,"complete":false}"#.utf8)
        )
        XCTAssertEqual(progress.operationId, "123e4567-e89b-12d3-a456-426614174000")
        XCTAssertEqual(progress.archivedTotal, 481)
        XCTAssertFalse(progress.complete)
    }

    func testWorkspaceSectionAvailabilityRequiresKnownAvailableVersion() throws {
        let available = try JSONDecoder().decode(
            WorkspaceSectionAvailability.self,
            from: Data(#"{"status":"available","version":1}"#.utf8)
        )
        let unavailable = try JSONDecoder().decode(
            WorkspaceSectionAvailability.self,
            from: Data(#"{"status":"unavailable","version":1,"message":"Retry"}"#.utf8)
        )
        let future = try JSONDecoder().decode(
            WorkspaceSectionAvailability.self,
            from: Data(#"{"status":"available","version":2}"#.utf8)
        )
        XCTAssertTrue(available.isAvailable)
        XCTAssertFalse(unavailable.isAvailable)
        XCTAssertFalse(future.isAvailable)
    }

    func testWorkspaceSectionPageDecodesLiveCursorAndAvailability() throws {
        let page = try JSONDecoder().decode(
            WorkspaceSectionPage<JSONValue>.self,
            from: Data(#"{"section":"skills","items":["skill-a"],"pagination":{"version":1,"consistency":"live-keyset","pageSize":50,"hasMore":true,"complete":false,"nextCursor":"opaque"},"availability":{"status":"available","version":1}}"#.utf8)
        )
        XCTAssertEqual(page.section, "skills")
        XCTAssertEqual(page.pagination.pageSize, 50)
        XCTAssertTrue(page.pagination.hasMore)
        XCTAssertFalse(page.pagination.complete)
        XCTAssertEqual(page.pagination.nextCursor, "opaque")
        XCTAssertTrue(page.availability.isAvailable)
    }

    func testWorkspacePaginationIndexKeepsCurrentAndArchivedChatCursorsSeparate() throws {
        let index = try JSONDecoder().decode(
            WorkspaceSectionPaginationIndex.self,
            from: Data(#"{"chats":{"current":{"endpoint":"/current","pageSize":50,"loaded":50,"hasMore":true,"complete":false,"nextCursor":"current-cursor","archived":false},"archived":{"endpoint":"/archived","pageSize":50,"loaded":12,"hasMore":false,"complete":true,"nextCursor":null,"archived":true}},"skills":{"endpoint":"/skills","pageSize":50,"loaded":50,"hasMore":true,"complete":false,"nextCursor":"skills-cursor","archived":null}}"#.utf8)
        )
        XCTAssertEqual(index.chats?.current.nextCursor, "current-cursor")
        XCTAssertEqual(index.chats?.archived.nextCursor, nil)
        XCTAssertEqual(index.skills?.loaded, 50)
    }

    func testDocumentAndPeoplePaginationMetadataIsOptionalButMustBeConsistent() throws {
        let legacy = try JSONDecoder().decode(
            DocumentsOverview.self,
            from: Data(#"{"documents":[],"stats":{"total":0,"ready":0,"pending":0,"chunks":0},"primaryConversationId":"primary"}"#.utf8)
        )
        XCTAssertNil(legacy.pagination)

        let valid = try JSONDecoder().decode(
            CursorPagination.self,
            from: Data(#"{"version":1,"consistency":"live-keyset","pageSize":50,"hasMore":true,"complete":false,"nextCursor":"opaque"}"#.utf8)
        )
        XCTAssertTrue(valid.isSupported)
        let malformed = try JSONDecoder().decode(
            CursorPagination.self,
            from: Data(#"{"version":1,"consistency":"live-keyset","pageSize":50,"hasMore":true,"complete":true,"nextCursor":null}"#.utf8)
        )
        XCTAssertFalse(malformed.isSupported)
    }

    func testDecisionReceiptsSeparatePermissionFromExecution() {
        let approved = DecisionReceiptPresentation(part: .init(type: "approval", status: "approved"))
        XCTAssertEqual(approved.title, "Approved")
        XCTAssertEqual(approved.tone, .success)
        XCTAssertTrue(approved.detail.contains("Permission"))
        XCTAssertTrue(approved.detail.contains("Activity"))
        XCTAssertFalse(approved.detail.contains("completed"))
        let budget = DecisionReceiptPresentation(part: .init(type: "budget-request", status: "approved"))
        XCTAssertEqual(budget.title, "Budget approved")
        XCTAssertTrue(budget.detail.contains("task’s outcome"))
        XCTAssertEqual(
            DecisionReceiptPresentation(part: .init(type: "approval", status: "denied")),
            DecisionReceiptPresentation(part: .init(type: "approval", status: "rejected"))
        )
    }

    func testDecisionReceiptsExplainFailureExpiryAndUnknownStatus() {
        for (status, title) in [
            ("denied", "Declined"), ("rejected", "Declined"), ("failed", "Request failed"),
            ("expired", "Expired"), ("cancelled", "Cancelled"), ("resolved", "Closed"),
            ("future_status", "Status unavailable")
        ] {
            let receipt = DecisionReceiptPresentation(part: .init(type: "approval", status: status))
            XCTAssertEqual(receipt.title, title)
            XCTAssertNotEqual(receipt.tone, .success)
        }
        XCTAssertTrue(DecisionReceiptPresentation(part: .init(type: "approval", status: "failed")).reviewInActivity)
        XCTAssertTrue(DecisionReceiptPresentation(part: .init(type: "approval", status: "expired")).reviewInActivity)
        XCTAssertTrue(DecisionReceiptPresentation(part: .init(type: "approval", status: "future_status")).reviewInApprovals)
        XCTAssertFalse(DecisionReceiptPresentation(part: .init(type: "approval", status: "approved")).reviewInActivity)
    }

    func testFinishedRowFallbackRequiresNoRenderableContent() {
        let empty = ChatMessage(id: "empty", role: .assistant, parts: [.init(type: "text", text: " \n ")])
        XCTAssertEqual(empty.outputFallback(isStreaming: false, hasRenderableCards: false)?.title, "No readable reply")
        XCTAssertNil(empty.outputFallback(isStreaming: true, hasRenderableCards: false))
        XCTAssertNil(empty.outputFallback(isStreaming: false, hasRenderableCards: true))
        var toolOnly = empty
        toolOnly.parts = [.init(type: "tool-result", data: .object(["result": .string("sensitive raw result")]))]
        XCTAssertEqual(toolOnly.outputFallback(isStreaming: false, hasRenderableCards: false)?.title, "No readable reply")
        XCTAssertFalse(toolOnly.outputFallback(isStreaming: false, hasRenderableCards: false)?.detail.contains("sensitive") ?? true)
        for part in [
            MessagePart(type: "approval", approvalId: "a1", status: "pending"),
            .init(type: "approval", approvalId: "a1", status: "failed"),
            .init(type: "suggestion", suggestionId: "s1", status: "accepted"),
            .init(type: "notice", notice: "provider-failed")
        ] {
            var structured = empty
            structured.parts = [part]
            XCTAssertNil(structured.outputFallback(isStreaming: false, hasRenderableCards: false))
        }
        let user = ChatMessage(id: "user", role: .user, parts: [])
        XCTAssertNil(user.outputFallback(isStreaming: false, hasRenderableCards: false))
    }

    func testUnknownCardFallbackPreservesReadableProseAndSupportedCards() {
        var message = ChatMessage(id: "new-card", role: .assistant, parts: [
            .init(type: "data-card", data: .object(["kind": .string("future-card")]))
        ])
        XCTAssertEqual(message.outputFallback(isStreaming: false, hasRenderableCards: false)?.title, "Card unavailable in this app")
        XCTAssertNil(message.outputFallback(isStreaming: false, hasRenderableCards: true))
        message.parts.append(.init(type: "text", text: "Here is the readable answer."))
        XCTAssertNil(message.outputFallback(isStreaming: false, hasRenderableCards: false))
    }

    func testImprovementReceiptRequiresExplicitExecutionEvidence() throws {
        let decoder = JSONDecoder()
        let legacy = try decoder.decode(ImprovementDecisionResult.self, from: Data(#"{"ok":true}"#.utf8))
        XCTAssertEqual(legacy.receiptTitle, "Decision recorded")
        for (outcome, enacted, title) in [
            ("applied", true, "Change applied"), ("acknowledged", false, "Marked reviewed"),
            ("dismissed", false, "Dismissed"), ("already_current", false, "Already using this configuration"),
            ("already_decided", false, "Already decided"), ("applied", false, "Decision recorded"),
            ("unknown", true, "Decision recorded")
        ] {
            let result = ImprovementDecisionResult(ok: true, outcome: outcome, enacted: enacted, detail: "Server receipt")
            XCTAssertEqual(result.receiptTitle, title)
            XCTAssertEqual(result.receiptDetail, "Server receipt")
        }
        let requested = try decoder.decode(ImprovementDecisionResult.self,
            from: Data(#"{"ok":true,"repairIssueId":"repair-1"}"#.utf8))
        XCTAssertEqual(requested.receiptTitle, "Code-fix report linked")
        XCTAssertTrue(requested.receiptDetail.contains("Code fixes"))
        XCTAssertEqual(ImprovementDecisionResult(ok: true, repairIssueId: "repair-1", repairStatus: "reported").receiptTitle, "Code-fix report queued")
        XCTAssertEqual(ImprovementDecisionResult(ok: true, repairIssueId: "repair-1", repairStatus: "failed").receiptTitle, "Code-fix report needs attention")
        XCTAssertEqual(ImprovementDecisionResult(ok: true, repairIssueId: "repair-1", repairStatus: "resolved").receiptTitle, "Code-fix report confirmed fixed")
        XCTAssertEqual(ImprovementDecisionResult(ok: false).receiptTitle, "Decision not confirmed")
    }

    func testImprovementActionsHaveOneSupportedCodeFixRoute() {
        let routing = ImprovementActionPresentation(applyable: true, canRequestCodeFix: true)
        XCTAssertEqual(routing.primaryAction, .apply)
        XCTAssertFalse(routing.offersAcknowledgment)
        let coding = ImprovementActionPresentation(applyable: false, canRequestCodeFix: true)
        XCTAssertEqual(coding.primaryAction.rawValue, "request_fix")
        XCTAssertTrue(coding.offersAcknowledgment)
        let advisory = ImprovementActionPresentation(applyable: false, canRequestCodeFix: false)
        XCTAssertEqual(advisory.primaryAction, .apply)
        XCTAssertEqual(advisory.primaryTitle, "Mark reviewed")
        XCTAssertFalse(advisory.offersAcknowledgment)
    }

    func testRepairMilestonesRequireDeploymentThenOwnerConfirmation() {
        for status in ["investigating", "fixing", "testing", "pr_open"] {
            let state = RepairPresentation(status: status)
            XCTAssertFalse(state.canConfirmFixed)
            XCTAssertFalse(state.canDismiss)
            XCTAssertFalse(state.canRetry)
        }
        XCTAssertEqual(RepairPresentation(status: "testing").title, "Testing")
        XCTAssertEqual(RepairPresentation(status: "merged").title, "Awaiting deployment")
        XCTAssertFalse(RepairPresentation(status: "merged").canConfirmFixed)
        XCTAssertFalse(RepairPresentation(status: "monitoring").canConfirmFixed)
        let deployed = RepairPresentation(status: "monitoring", deploymentConfirmed: true)
        XCTAssertEqual(deployed.title, "Deployed · needs confirmation")
        XCTAssertTrue(deployed.canConfirmFixed)
        XCTAssertFalse(deployed.isClosed)
        let confirmed = RepairPresentation(status: "resolved")
        XCTAssertEqual(confirmed.title, "Confirmed fixed")
        XCTAssertTrue(confirmed.isClosed)
        XCTAssertFalse(confirmed.canConfirmFixed)
        XCTAssertFalse(confirmed.canDismiss)
        XCTAssertTrue(RepairPresentation(status: "dismissed").isClosed)
        for status in ["failed", "blocked"] {
            XCTAssertTrue(RepairPresentation(status: status).canRetry)
            XCTAssertTrue(RepairPresentation(status: status).canRequestManualRun)
        }
        XCTAssertFalse(RepairPresentation(status: "reported", manualRunRequested: true).canRequestManualRun)
        let unknown = RepairPresentation(status: "future_state")
        XCTAssertFalse(unknown.canDismiss || unknown.canRetry || unknown.canRequestManualRun || unknown.canConfirmFixed)
    }

    func testRepairProjectionSupportsLegacyAndEvidencePayloads() throws {
        let data = Data(#"{"id":"issue","title":"Broken behavior","summary":"What happened","status":"reported","diagnosis":"","lastError":"","sourceTaskId":null,"prUrl":null,"runUrl":null,"updatedAt":"2026-10-03T19:00:00.000Z"}"#.utf8)
        var issue = try JSONDecoder().decode(WorkspaceRepairIssue.self, from: data)
        XCTAssertNil(issue.history)
        XCTAssertNil(issue.mergeSha)
        let oldRevision = issue.actionRevision
        issue.manualRunRequested = true
        XCTAssertNotEqual(issue.actionRevision, oldRevision, "A saved manual request changes action availability before investigation starts")
        let enriched = Data(#"{"id":"issue","title":"Broken behavior","summary":"What happened","status":"monitoring","diagnosis":"Verified deployed revision","lastError":"","sourceTaskId":null,"prUrl":null,"runUrl":null,"updatedAt":"2026-10-03T19:00:00.000Z","mergeSha":"abc123","history":[{"status":"merged","at":"2026-10-03T18:00:00.000Z","detail":"Merged code"}]}"#.utf8)
        let projected = try JSONDecoder().decode(WorkspaceRepairIssue.self, from: enriched)
        XCTAssertEqual(projected.mergeSha, "abc123")
        XCTAssertEqual(projected.history?.first?.status, "merged")
        XCTAssertEqual(projected.history?.first?.detail, "Merged code")
    }
}

enum RichMessageFixture {
    static let alert: JSONValue = .object([
        "kind": .string("proactive-alert"), "id": .string("email-report"),
        "category": .string("email"), "urgencyLabel": .string("For your attention"),
        "title": .string("Weekly progress report"),
        "summary": .string("The report includes a test on Friday and a deadline for missing work. Review the dates and any follow-up needed."),
        "details": .array([.object(["label": .string("From"), "value": .string("Teacher <teacher@example.edu>")])])
    ])
    static var suggestion: MessagePart {
        .init(type: "suggestion", suggestionId: "s1", summary: "Review the report and highlight what needs attention.",
            status: "pending", contextCard: alert, actionLabel: "Review email")
    }
    static func generated(state: String = "idle", stale: Bool = false, updatedAt: String = "2026-09-19T18:00:00.000Z") -> MessagePart {
        .init(type: "data-card", data: .object([
            "kind": .string("generated-card"), "id": .string("saved-1"), "revisionId": .string("r1"),
            "updatedAt": .string(updatedAt), "stale": .bool(stale), "refreshState": .string(state),
            "refreshTaskId": .string("refresh-1"),
            "spec": .object([
                "version": .number(1), "title": .string("Your travel plan"), "sourceLabel": .string("Travel"),
                "facts": .array([
                    .object(["id": .string("flight"), "label": .string("Friday · 9:30 AM"), "value": .string("Flight to Lisbon, with enough time to check in and drop off your bags.")]),
                    .object(["id": .string("hotel"), "label": .string("Friday · 3:00 PM"), "value": .string("Hotel check-in near the old town. Keep your confirmation and arrival details handy.")])
                ]),
                "blocks": .array([.object(["type": .string("timeline"), "factIds": .array([.string("flight"), .string("hotel")])])]),
                "actions": .array([.object(["id": .string("refresh"), "type": .string("refresh"), "label": .string("Refresh")])])
            ])
        ]))
    }
}

enum PeopleMapFixture {
    static func relation(_ id: String, name: String, sentence: String, contact: String? = nil,
                         unreviewed: Bool = false) -> PersonRelationSummary {
        .init(id: id, sentence: sentence, otherLabel: name, otherInitials: String(name.prefix(1)),
              otherContactId: contact, span: "", unreviewed: unreviewed)
    }
    static let relations: [PersonRelationSummary] = [
        relation("father", name: "Alex Morgan", sentence: "Alex Morgan is Robin Morgan's father.", contact: "alex"),
        relation("inverse", name: "Alex Morgan", sentence: "Robin Morgan is Alex Morgan's daughter.", contact: "alex"),
        relation("conflict", name: "Alex Morgan", sentence: "Alex Morgan is Robin Morgan's child.", contact: "alex", unreviewed: true),
        relation("mother", name: "Katharine Leigh Innes", sentence: "Katharine Leigh Innes is Robin Morgan's mother.", contact: "kat"),
        relation("sibling", name: "Brynjar Smári Baldvinsson", sentence: "Robin Morgan and Brynjar Smári Baldvinsson are siblings.", contact: "brynjar"),
        relation("custom", name: "Dr. Taylor Lee", sentence: "Dr. Taylor Lee attended a workshop with Robin Morgan.", unreviewed: true),
        relation("sam", name: "Sam Morgan", sentence: "Robin Morgan and Sam Morgan are partners.", contact: "sam")
    ]
    static func card(relations: [PersonRelationSummary] = relations) -> PersonCard {
        .init(id: "robin", name: "Robin Morgan", initials: "RM", relationship: "", group: "other",
              groupLabel: "", trust: "owner", location: nil, birthday: nil, lastContact: nil,
              howWeMet: [], relations: relations, connections: [], events: [], eventsAreRecent: false,
              reminder: nil, factCount: relations.count)
    }
}

final class APIModelsTests: XCTestCase {
    func testSuggestionContextOnlySuppressesItsExplicitMatchingAlert() throws {
        let message = ChatMessage(id: "m", role: .assistant, parts: [
            RichMessageFixture.suggestion, .init(type: "data-card", data: RichMessageFixture.alert),
            RichMessageFixture.generated()
        ])
        XCTAssertEqual(message.suggestionParts.first?.suggestionContext?.id, "email-report")
        XCTAssertEqual(message.standaloneResponseCards.map(\.id), ["saved-1"])
        XCTAssertEqual(message.suggestionParts.first?.suggestionActionLabel, "Review email")
        let decoded = try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(message))
        XCTAssertEqual(decoded, message)
        var unpaired = message
        unpaired.parts[0].contextCard = nil
        XCTAssertEqual(unpaired.standaloneResponseCards.count, 2, "Never guess a pairing from adjacent cards")
        unpaired.parts[0].actionLabel = "  "
        XCTAssertEqual(unpaired.parts[0].suggestionActionLabel, "Start task")
        var invalid = message
        invalid.parts[0].contextCard = .object(["kind": .string("proactive-alert"), "id": .string("email-report")])
        XCTAssertEqual(invalid.standaloneResponseCards.count, 2, "Malformed context must not hide a readable source card")
        var unrelated = message
        unrelated.parts[0].contextCard = .object([
            "kind": .string("proactive-alert"), "id": .string("other"), "title": .string("Another alert")
        ])
        XCTAssertEqual(unrelated.standaloneResponseCards.count, 2)
    }

    func testCardFreshnessAndRefreshGuardPreserveOldDataUntilRevalidated() throws {
        let original = ChatMessage(id: "m", role: .assistant, parts: [RichMessageFixture.generated()])
        let marker = CardRefreshMarker(revisionId: "r1", updatedAt: "2026-09-19T18:00:00.000Z", taskId: "refresh-2")
        XCTAssertTrue(original.applyingCardRefreshes(["saved-1": marker]).hasRefreshingCard)
        var priorFailure = original
        priorFailure.parts = [RichMessageFixture.generated(state: "failed")]
        XCTAssertTrue(priorFailure.applyingCardRefreshes(["saved-1": marker]).hasRefreshingCard,
            "The previous refresh's failure must not end the newly accepted attempt")
        let fresh = ChatMessage(id: "m", role: .assistant, parts: [
            RichMessageFixture.generated(updatedAt: "2026-09-19T18:01:00.000Z")
        ])
        XCTAssertEqual(fresh.applyingCardRefreshes(["saved-1": marker]), fresh)
        let failedMarker = CardRefreshMarker(revisionId: "r1", updatedAt: "2026-09-19T18:00:00.000Z", taskId: "refresh-1")
        XCTAssertEqual(priorFailure.applyingCardRefreshes(["saved-1": failedMarker]), priorFailure)
        XCTAssertEqual(original.applyingCardRefreshes(["saved-1": failedMarker]), original,
            "An idle response for the accepted refresh task settles even if its revision is unchanged")
        guard case let .generated(card)? = MessageResponseCard(part: original.parts[0]) else { return XCTFail("Expected generated card") }
        XCTAssertEqual(card.updatedAt, "2026-09-19T18:00:00.000Z")
        XCTAssertEqual(card.stale, false)
        XCTAssertEqual(CardFreshnessPresentation.label(stale: false, state: "idle", hasTimestamp: true), "Current")
        XCTAssertEqual(CardFreshnessPresentation.label(stale: nil, state: nil, hasTimestamp: false), "Saved snapshot")
        XCTAssertEqual(CardFreshnessPresentation.label(stale: true, state: "idle", hasTimestamp: true), "May be out of date")
        XCTAssertEqual(CardFreshnessPresentation.label(stale: false, state: "refreshing", hasTimestamp: true), "Refreshing…")
        XCTAssertEqual(CardFreshnessPresentation.label(stale: true, state: "failed", hasTimestamp: true), "Refresh failed")
    }

    func testGeneratedCardProgressiveDetailsKeepEveryTimelineFactInOrder() throws {
        guard case let .generated(card)? = MessageResponseCard(part: RichMessageFixture.generated()) else { return XCTFail("Missing fixture") }
        let ids = ["one", "two", "three", "four", "five", "six"]
        let timeline = MessageResponseCard.GeneratedBlock(id: "timeline", type: "timeline",
            values: ["factIds": .array(ids.map(JSONValue.string))])
        let long = MessageResponseCard.GeneratedCard(id: card.id, groundedOnAnswer: false,
            title: card.title, subtitle: "", sourceLabel: card.sourceLabel, icon: card.icon,
            accessibilityLabel: card.accessibilityLabel, facts: card.facts,
            blocks: [timeline, .init(id: "note1", type: "note", values: [:]), .init(id: "note2", type: "note", values: [:])],
            actions: [], form: nil, steps: [])
        let split = long.blockSections
        XCTAssertEqual(split.preview.map(\.id), ["timeline", "note1"])
        XCTAssertEqual(split.details.map(\.id), ["timeline-continued", "note2"])
        XCTAssertEqual(split.preview[0].values["factIds"], .array(ids.prefix(4).map(JSONValue.string)))
        XCTAssertEqual(split.details[0].values["factIds"], .array(ids.suffix(2).map(JSONValue.string)))
        XCTAssertEqual(split.details[0].values["startIndex"], .number(5))
    }

    func testPeopleMapKeepsContradictionsUnknownRolesAndExactEvidence() throws {
        let branches = PeopleConnectionBranch.branches(for: PeopleMapFixture.card())
        XCTAssertEqual(branches.count, 5)
        let alex = try XCTUnwrap(branches.first { $0.contactID == "alex" })
        XCTAssertEqual(alex.label, "Child · Father")
        XCTAssertTrue(alex.needsReview)
        XCTAssertEqual(alex.group.relations.map(\.id), ["father", "inverse", "conflict"])
        let unknown = try XCTUnwrap(branches.first { $0.contactID == nil })
        XCTAssertEqual(unknown.label, "Recorded connection")
        XCTAssertEqual(unknown.detail, PeopleMapFixture.relations[5].sentence)
        XCTAssertEqual(unknown.group.representative.sentence, PeopleMapFixture.relations[5].sentence)
        XCTAssertEqual(branches.map(\.id), PeopleConnectionBranch.branches(
            for: PeopleMapFixture.card(relations: PeopleMapFixture.relations.reversed())).map(\.id))
        XCTAssertEqual(branches.flatMap { $0.group.relations }.count, PeopleMapFixture.relations.count)
    }

    func testPeopleMapDoesNotInventSelfLinksOrMergeDistinctPeopleWithSameName() {
        let rows = [
            PeopleMapFixture.relation("self", name: "Robin Morgan", sentence: "Self record", contact: "robin"),
            PeopleMapFixture.relation("one", name: "Alex", sentence: "A recorded mention", contact: "one"),
            PeopleMapFixture.relation("two", name: "Alex", sentence: "Another mention", contact: "two"),
            PeopleMapFixture.relation("unknown", name: "Alex", sentence: "Unlinked mention")
        ]
        let branches = PeopleConnectionBranch.branches(for: PeopleMapFixture.card(relations: rows))
        XCTAssertEqual(branches.count, 3)
        XCTAssertEqual(Set(branches.compactMap(\.contactID)), ["one", "two"])
        XCTAssertTrue(PeopleConnectionBranch.branches(for: PeopleMapFixture.card(relations: [])).isEmpty)
        let historical = PersonRelationSummary(id: "old", sentence: "Alex is Robin Morgan's spouse.",
            otherLabel: "Alex", otherInitials: "A", otherContactId: "alex", span: "2010–2015", unreviewed: false)
        XCTAssertEqual(PeopleConnectionBranch.branches(for: PeopleMapFixture.card(relations: [historical])).first?.detail,
            "2010–2015", "The map must retain the stated relationship period")
    }

    func testPeopleMapTraversalRetracesCyclesWithoutDuplicatingNavigation() {
        XCTAssertEqual(PeopleConnectionBranch.exploring("robin", from: []), ["robin"])
        XCTAssertEqual(PeopleConnectionBranch.exploring("alex", from: ["robin"]), ["robin", "alex"])
        XCTAssertEqual(PeopleConnectionBranch.exploring("robin", from: ["robin", "alex"]), ["robin"])
        XCTAssertEqual(PeopleConnectionBranch.exploring("alex", from: ["robin", "alex"]), ["robin", "alex"])
    }
    func testLocationFixRejectsCachedInaccurateAndUnconfirmedSamples() {
        let now = Date()
        func fix(age: TimeInterval = 0, accuracy: Double = 30, latitude: Double = 37.77) -> CLLocation {
            CLLocation(coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: -122.42),
                altitude: 0, horizontalAccuracy: accuracy, verticalAccuracy: -1,
                timestamp: now.addingTimeInterval(-age))
        }
        XCTAssertTrue(LocationFixPolicy.isUsable(fix(), now: now))
        for sample in [fix(age: 60), fix(age: -60), fix(accuracy: -1), fix(accuracy: 3000), fix(latitude: 100)] {
            XCTAssertFalse(LocationFixPolicy.isUsable(sample, now: now))
        }
        XCTAssertTrue(LocationFixPolicy.confirms(fix(age: 3), with: fix(), now: now))
        XCTAssertFalse(LocationFixPolicy.confirms(fix(), with: fix(), now: now))
        XCTAssertFalse(LocationFixPolicy.confirms(fix(age: 1), with: fix(), now: now))
        XCTAssertFalse(LocationFixPolicy.confirms(fix(age: 20), with: fix(), now: now))
        XCTAssertFalse(LocationFixPolicy.confirms(fix(age: 3), with: fix(latitude: 37.8), now: now))
        XCTAssertFalse(LocationFixPolicy.confirms(fix(age: 3), with: fix(accuracy: 3000), now: now))
    }

    func testModelProviderSettingsGroupOnlyUsableChatModels() throws {
        let json = """
        {"connections":[
          {"id":"openai","kind":"openai","label":"OpenAI","baseUrl":null,"vertexProject":null,"vertexLocation":null,
           "hasApiKey":true,"enabled":true,"source":"saved","lastTestedAt":null,"lastError":null},
          {"id":"groq","kind":"openai_compatible","label":"Groq","baseUrl":"https://api.groq.com/openai/v1",
           "vertexProject":null,"vertexLocation":null,"hasApiKey":true,"enabled":false,"source":"saved",
           "lastTestedAt":"2026-09-27T07:18:44.650Z","lastError":"The provider rejected the API key."}],
         "models":[
          {"id":"openai:gpt-5.1","label":"GPT-5.1","connectionId":"openai","enabled":true,"routable":true,
           "embedding":false,"promptCostPerMTok":"1.2500","completionCostPerMTok":"10.0000"},
          {"id":"openai:text-embedding-3-small","label":"Embeddings","connectionId":"openai","enabled":true,
           "routable":true,"embedding":true,"promptCostPerMTok":"0.0200","completionCostPerMTok":"0.0000"},
          {"id":"openai:unpriced","label":"Unpriced","connectionId":"openai","enabled":true,"routable":false,
           "embedding":false,"promptCostPerMTok":null,"completionCostPerMTok":null},
          {"id":"gw:groq:llama","label":"Llama","connectionId":"groq","enabled":true,"routable":true,
           "embedding":false,"promptCostPerMTok":"0.5900","completionCostPerMTok":"0.7900"}],
         "roles":[{"role":"reason","primaryModel":"openai:gpt-5.1","fallbackModel":"openai:gpt-5.1"}],
         "mainModel":"openai:gpt-5.1","fastModel":null}
        """
        let settings = try JSONDecoder().decode(ModelProviderSettings.self, from: Data(json.utf8))
        XCTAssertEqual(settings.mainModel, "openai:gpt-5.1")
        XCTAssertNil(settings.fastModel)
        // Embeddings, unpriced models, and models behind a turned-off connection are not choosable.
        XCTAssertEqual(settings.choosableGroups.map(\.connection.id), ["openai"])
        XCTAssertEqual(settings.choosableGroups.first?.models.map(\.id), ["openai:gpt-5.1"])
        XCTAssertEqual(settings.models.first?.priceLabel, "$1.25 / $10.00 per M tokens")
        XCTAssertEqual(settings.connections.last?.kindLabel, "OpenAI-compatible")
    }

    func testSituationPackMissingRouteHasActionableCopy() {
        XCTAssertEqual(
            SituationPackLoadFailure.message(for: APIError.server(status: 404, message: "not found")),
            "Situation packs aren’t available on this server yet. Update the server, then try again.")
        XCTAssertEqual(
            SituationPackLoadFailure.message(for: APIError.unauthorized),
            APIError.unauthorized.localizedDescription)
    }
    func testSituationPackDecodesResponsibilityAndReviewWithoutInventingCompletion() throws {
        let data = Data("""
        {"packs":[{"id":"pack","title":"Soccer weekend","version":3,"archived":false,"updatedAt":"2026-09-06T12:00:00Z",
        "data":{"items":[{"id":"ride","title":"Confirm ride","details":"","lane":"i_owe","dependsOn":["reply"],"source":null,"snapshot":null,"needsReview":true}],"decisions":[{"id":"dinner","option":"Late dinner","outcome":"rejected","reason":"Too late","scope":"situation","confirmed":true}]},"changes":[],"affectedIds":["ride"]}],"sources":[]}
        """.utf8)
        let overview = try JSONDecoder().decode(SituationOverview.self, from: data)
        XCTAssertEqual(overview.packs.first?.data.items.first?.lane, "i_owe")
        XCTAssertEqual(overview.packs.first?.data.items.first?.needsReview, true)
        XCTAssertEqual(overview.packs.first?.data.decisions.first?.scope, "situation")
    }

    func testSituationPreviewCommandPreservesVersionAndSourceIdentity() throws {
        let item = SituationItem(title: "New hotel", source: .init(kind: "card", id: "card-id"))
        let command = SituationCommand(action: "preview", packId: "pack-id", version: 7, item: item)
        let data = try JSONEncoder().encode(command)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["action"] as? String, "preview")
        XCTAssertEqual(json["version"] as? Int, 7)
        XCTAssertNil(json["previewId"])
        let encodedItem = try XCTUnwrap(json["item"] as? [String: Any])
        XCTAssertEqual((encodedItem["source"] as? [String: String])?["id"], "card-id")
    }
    func testApprovalSummaryDecodesApprovedDeniedAndExpiredOutcomes() throws {
        for status in ["approved", "denied", "expired"] {
            let data = Data("""
            {"id":"summary","role":"assistant","parts":[
              {"type":"approval-summary","purpose":"Check a place","approvalCount":1,
               "approvalIds":["a1"],"pendingCount":0,
               "outcomes":[{"id":"a1","summary":"Search the web","status":"\(status)"}]}
            ]}
            """.utf8)
            let message = try JSONDecoder().decode(ChatMessage.self, from: data)
            XCTAssertEqual(message.approvalSummary?.pendingCount, 0)
            XCTAssertEqual(message.approvalSummary?.outcomes.first?.status, status)
            XCTAssertFalse(message.hasPendingDecision)
            XCTAssertTrue(message.visibleTextBubbles.isEmpty)
        }
    }

    func testApprovalSummariesStayInPollingUntilEveryDecisionIsAnswered() throws {
        let legacy = ChatMessage(id: "legacy", role: .assistant,
            parts: [.init(type: "approval-summary", purpose: "Check a place", approvalCount: 2)])
        XCTAssertTrue(legacy.hasPendingDecision)
        XCTAssertEqual(legacy.approvalSummary?.pendingCount, 2)
        let pending = ChatMessage(id: "linked", role: .assistant,
            parts: [.init(type: "approval-summary", purpose: "Check a place", approvalCount: 2,
                approvalIds: ["a1", "a2"], pendingCount: 2,
                outcomes: [.init(id: "a1", summary: "First", status: "pending"),
                    .init(id: "a2", summary: "Second", status: "pending")])])
        let partial = pending.applyingApprovalDecisions(["a1": "approved"])
        XCTAssertEqual(partial.approvalSummary?.pendingCount, 1)
        XCTAssertTrue(partial.hasPendingDecision)
        XCTAssertEqual(partial.applyingApprovalDecisions(["a1": "approved"]), partial,
            "Repeated receipts must not decrement the count twice")
        let settled = partial.applyingApprovalDecisions(["a2": "denied"])
        XCTAssertEqual(settled.approvalSummary?.pendingCount, 0)
        XCTAssertFalse(settled.hasPendingDecision)
        XCTAssertEqual(settled.approvalSummary?.outcomes.map(\.status), ["approved", "denied"])
    }

    func testAcceptedDecisionOverlaysStalePollWithoutChangingOtherApprovalsOrText() {
        let pending = ChatMessage(id: "linked", role: .assistant, parts: [
            .init(type: "text", text: "Original context"),
            .init(type: "approval", approvalId: "a1", status: "pending"),
            .init(type: "approval-summary", purpose: "Check a place", approvalCount: 2,
                approvalIds: ["a1", "a2"]),
        ])
        for status in ["approved", "denied"] {
            let decisions = ["a1": status]
            let settled = pending.applyingApprovalDecisions(decisions)
            XCTAssertEqual(settled.parts[1].status, status)
            XCTAssertEqual(settled.approvalSummary?.pendingCount, 1)
            XCTAssertEqual(settled.text, "Original context")
            XCTAssertEqual(pending.applyingApprovalDecisions(decisions), settled)
        }
        XCTAssertEqual(pending.applyingApprovalDecisions([:]), pending,
            "No acknowledged decision means no change, including after a failed request")
        XCTAssertEqual(pending.applyingApprovalDecisions(["unrelated": "approved"]), pending)
    }

    func testPeopleGroupsInverseFamilyFactsAndKeepsEveryEvidenceRow() throws {
        func relation(_ id: String, _ sentence: String, _ name: String, contact: String? = nil,
            unreviewed: Bool = false, span: String = "") -> PersonRelationSummary {
            .init(id: id, sentence: sentence, otherLabel: name, otherInitials: "AB",
                otherContactId: contact, span: span, unreviewed: unreviewed)
        }
        let rows = [
            relation("1", "Alex is Robin's father.", "Alex"),
            relation("2", "Robin is Alex's daughter.", "Alex"),
            relation("3", "Alex is Robin's is father.", "Alex"),
            relation("4", "Alex visited with Robin.", "Alex", unreviewed: true, span: "Since 2024"),
            relation("5", "Dr. Lee attended Robin.", "Dr. Lee"),
            relation("6", "Robin and Sam are siblings.", "Sam", contact: "sam"),
        ]
        let groups = PersonRelationGroup.group(rows, personName: "Robin")
        XCTAssertEqual(groups.count, 3)
        XCTAssertEqual(groups[0].roles, ["Father"])
        XCTAssertEqual(groups[0].relationshipEvidence.map(\.id), ["1", "2", "3"])
        XCTAssertEqual(groups[0].otherDetails.map(\.id), ["4"])
        XCTAssertTrue(groups[0].otherDetails[0].unreviewed)
        XCTAssertEqual(groups[0].otherDetails[0].span, "Since 2024")
        XCTAssertEqual(groups.flatMap(\.relations).count, rows.count)
        XCTAssertEqual(groups[1].roles, [])
        XCTAssertEqual(groups[2].roles, ["Sibling"])
        XCTAssertEqual(groups[2].representative.otherContactId, "sam")
    }

    func testPeopleGroupingDoesNotGuessRolesOrMergeDistinctContactIDs() {
        let rows = [
            PersonRelationSummary(id: "1", sentence: "Alex is Robin's father.", otherLabel: "Alex",
                otherInitials: "A", otherContactId: "alex1", span: "", unreviewed: true),
            PersonRelationSummary(id: "2", sentence: "Alex is Robin's mother.", otherLabel: "Alex",
                otherInitials: "A", otherContactId: "alex2", span: "", unreviewed: false),
            PersonRelationSummary(id: "3", sentence: "Alex visited Robin's father.", otherLabel: "Alex",
                otherInitials: "A", otherContactId: nil, span: "", unreviewed: false),
        ]
        let groups = PersonRelationGroup.group(rows, personName: "Robin")
        XCTAssertEqual(groups.count, 3)
        XCTAssertEqual(groups.map(\.roles), [["Father"], ["Mother"], []])
        XCTAssertNil(PersonRelationGroup.role(rows[0], personName: "Someone else"))
        XCTAssertTrue(PersonRelationGroup.group([], personName: "Robin").isEmpty)
    }

    func testMenuHeightCountsThePartiallyFilledPeopleAndMoreRow() {
        XCTAssertEqual(PullMenuMotion.menuRowCount(itemCount: 9, columns: 2), 5)
        XCTAssertEqual(PullMenuMotion.menuRowCount(itemCount: 9, columns: 3), 3)
        XCTAssertEqual(PullMenuMotion.menuRowCount(itemCount: 9, columns: 9), 1)
        XCTAssertEqual(PullMenuMotion.menuRowCount(itemCount: 8, columns: 2), 4)
        XCTAssertEqual(PullMenuMotion.menuRowCount(itemCount: 0, columns: 2), 0)
        XCTAssertEqual(PullMenuMotion.menuRowCount(itemCount: 9, columns: 0), 0)
    }

    @MainActor
    func testPeopleAndRelationshipLinksPushAboveDirectoryAndPopInOrder() {
        let model = AppModel()
        model.present(.people)
        model.navigationPath.append(.person(id: "ada"))
        model.navigationPath.append(.person(id: "grace"))
        XCTAssertEqual(model.navigationPath, [.route(.people), .person(id: "ada"), .person(id: "grace")])
        XCTAssertEqual(model.presentedRoute, .people)

        model.navigationPath.removeLast()
        XCTAssertEqual(model.navigationPath.last, .person(id: "ada"))
        model.navigationPath.removeLast()
        XCTAssertEqual(model.navigationPath, [.route(.people)])
        model.navigationPath.removeLast()
        XCTAssertNil(model.presentedRoute)
    }

    @MainActor
    func testChangingRouteAndReturningToChatClearPersonHistory() {
        let model = AppModel()
        model.present(.people)
        model.navigationPath.append(.person(id: "ada"))
        model.present(.approvals)
        XCTAssertEqual(model.navigationPath, [.route(.approvals)])
        model.returnToChat()
        XCTAssertTrue(model.navigationPath.isEmpty)

        model.present(.people)
        model.navigationPath.append(.person(id: "grace"))
        model.present(.chat)
        XCTAssertTrue(model.navigationPath.isEmpty)
        XCTAssertNil(model.presentedRoute)
    }

    @MainActor
    func testMemoryDirectoryShortcutUsesSameNavigationPath() {
        let model = AppModel()
        model.present(.memory)
        model.presentedRoute = .people
        XCTAssertEqual(model.navigationPath, [.route(.people)])
        model.navigationPath.append(.person(id: "ada"))
        model.presentedRoute = nil
        XCTAssertTrue(model.navigationPath.isEmpty)
    }

    func testLookupCardsDoNotReplaceTheirAnswer() throws {
        let data = Data(#"{"id":"m1","role":"assistant","parts":[{"type":"text","text":"These interviews are historical, not current applications."},{"type":"data-card","data":{"kind":"calendar-event","id":"e1","title":"Interview"}}]}"#.utf8)
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertTrue(message.hasSupportingResultCards)
        XCTAssertEqual(message.visibleTextBubbles, ["These interviews are historical, not current applications."])
        XCTAssertFalse(ChatMessage.optimistic(role: .user, text: "Hello").hasSupportingResultCards)
    }
    func testDecodesRetractedMessageWithoutRenderingItsOriginalAsMarkdown() throws {
        let data = #"{"id":"m1","role":"assistant","parts":[{"type":"text","text":"This response was retracted."},{"type":"notice","notice":"retracted","reason":"Unsupported source data.","originalText":"[Fake link](https://example.invalid)","repairId":"repair-v1"}]}"#.data(using: .utf8)!
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertEqual(message.noticeKind, .retracted)
        XCTAssertEqual(message.retractionReason, "Unsupported source data.")
        XCTAssertEqual(message.retractedOriginalText, "[Fake link](https://example.invalid)")
    }

    func testKnowledgeCleanupAndImpactDecode() throws {
        let cleanup = try JSONDecoder().decode(
            KnowledgeCleanupResponse.self,
            from: Data(#"{"findings":[{"id":"unreviewed_connection:r1","kind":"unreviewed_connection","title":"Review a new connection","detail":"Ada works at Acme.","memoryId":"m1","relationId":"r1","count":1}]}"#.utf8)
        )
        XCTAssertEqual(cleanup.findings.first?.relationId, "r1")
        let impact = try JSONDecoder().decode(
            KnowledgeSourceImpact.self,
            from: Data(#"{"memoryId":"m1","content":"Ada works at Acme.","connectionCount":1,"orphanedItems":[{"id":"e1","label":"Acme"}]}"#.utf8)
        )
        XCTAssertEqual(impact.connectionCount, 1)
        XCTAssertEqual(impact.orphanedItems.first?.label, "Acme")
    }

    @MainActor
    func testMemoryReviewBadgeFollowsLatestServerProjection() {
        let model = AppModel()
        let health = { (awaitingReview: Int) in
            MemoryHealth(
                totalUsable: 12,
                notYetOrganized: 2,
                awaitingReview: awaitingReview,
                ownerConfirmed: 4,
                lastOrganizedAt: nil
            )
        }

        model.applyMemoryHealth(health(1))
        XCTAssertEqual(model.memoryReviewCount, 1)

        model.applyMemoryHealth(health(0))
        XCTAssertEqual(model.memoryReviewCount, 0)
    }

    func testAssistantFlowLayoutUsesConsistentSpacingAndWrapping() {
        let metrics = AssistantFlowLayout.metrics(
            sizes: [
                CGSize(width: 50, height: 20),
                CGSize(width: 40, height: 30),
                CGSize(width: 30, height: 10),
            ],
            availableWidth: 100,
            spacing: 8
        )

        XCTAssertEqual(
            metrics.origins,
            [CGPoint(x: 0, y: 0), CGPoint(x: 58, y: 0), CGPoint(x: 0, y: 38)]
        )
        XCTAssertEqual(metrics.size, CGSize(width: 98, height: 48))
    }

    func testPollingPolicyBacksOffWithoutMakingFreshRepliesFeelSlow() {
        XCTAssertEqual(PollingPolicy.callIntervalSeconds(consecutiveFailures: 0), 2)
        XCTAssertGreaterThan(PollingPolicy.callIntervalSeconds(consecutiveFailures: 1), 2)
        XCTAssertEqual(PollingPolicy.callIntervalSeconds(consecutiveFailures: 100), 8)
        XCTAssertEqual(PollingPolicy.replyIntervalMilliseconds(attempt: 1, hasTaskID: false), 650)
        XCTAssertEqual(PollingPolicy.replyIntervalMilliseconds(attempt: 8, hasTaskID: false), 1_500)
        XCTAssertEqual(PollingPolicy.replyIntervalMilliseconds(attempt: 24, hasTaskID: false), 2_500)
        XCTAssertEqual(PollingPolicy.replyIntervalMilliseconds(attempt: 4, hasTaskID: true), 3_000)
        XCTAssertEqual(PollingPolicy.replyIntervalMilliseconds(attempt: 20, hasTaskID: true), 5_000)
        XCTAssertEqual(PollingPolicy.idleIntervalSeconds(unchangedPolls: 0), 12)
        XCTAssertEqual(PollingPolicy.idleIntervalSeconds(unchangedPolls: 6), 48)
        XCTAssertEqual(PollingPolicy.idleIntervalSeconds(unchangedPolls: 10), 90)
    }

    func testHandsFreeStopsForPendingDecisionsButAllowsResolvedReceiptsAndSuggestions() {
        let pending = ChatMessage(id: "approval", role: .assistant, parts: [.init(type: "approval", status: "pending")])
        var approved = pending
        approved.parts[0].status = "approved"
        XCTAssertTrue(TalkInteractionPolicy.requiresManualDecision(messages: [pending], pendingApprovals: 0))
        XCTAssertEqual(TalkInteractionPolicy.decisionRoute(messages: [pending]), .approvals)
        XCTAssertFalse(TalkInteractionPolicy.requiresManualDecision(messages: [approved], pendingApprovals: 0))
        XCTAssertTrue(TalkInteractionPolicy.requiresManualDecision(messages: [], pendingApprovals: 1))

        let suggestion = ChatMessage(id: "suggestion", role: .assistant, parts: [.init(type: "suggestion", suggestionId: "s1", status: "pending")])
        XCTAssertFalse(TalkInteractionPolicy.requiresManualDecision(messages: [suggestion], pendingApprovals: 0))
        let budget = ChatMessage(id: "budget", role: .assistant, parts: [.init(type: "budget-request", status: "pending")])
        XCTAssertTrue(TalkInteractionPolicy.requiresManualDecision(messages: [budget], pendingApprovals: 0))
        XCTAssertEqual(TalkInteractionPolicy.decisionRoute(messages: [pending, budget]), .activity)
    }

    func testHeldPollAsksAgainImmediatelyBecauseTheHoldWasTheWait() {
        // 20s round trip: the server held the connection, so waiting again
        // locally would only delay a reply that is already overdue.
        XCTAssertEqual(
            PollingPolicy.gapMilliseconds(
                elapsedMilliseconds: 20_000,
                carriedNews: false,
                attempt: 30,
                hasTaskID: true
            ),
            0
        )
        XCTAssertEqual(
            PollingPolicy.idleGapSeconds(elapsedMilliseconds: 20_000, unchangedPolls: 10),
            0
        )
    }

    func testAnImmediateAnswerFallsBackToTheTimedCadence() {
        // A server too old to understand `wait` answers at once and reports
        // nothing. Without the fallback this loop would spin on the radio.
        XCTAssertEqual(
            PollingPolicy.gapMilliseconds(
                elapsedMilliseconds: 40,
                carriedNews: false,
                attempt: 20,
                hasTaskID: true
            ),
            5_000
        )
        XCTAssertEqual(
            PollingPolicy.idleGapSeconds(elapsedMilliseconds: 40, unchangedPolls: 10),
            90
        )
        // News that arrived at once is the other reason for a fast answer:
        // ask again promptly, but never in a tight loop.
        XCTAssertEqual(
            PollingPolicy.gapMilliseconds(
                elapsedMilliseconds: 40,
                carriedNews: true,
                attempt: 20,
                hasTaskID: true
            ),
            250
        )
    }

    func testHoldStaysUnderTheServerCeiling() {
        // MAX_CHAT_WAIT_MS in the application service is 25s. Asking for less
        // keeps the server the one that ends the hold.
        XCTAssertLessThan(PollingPolicy.holdMilliseconds, 25_000)
    }

    func testChatUpdatesDecodesSupersededRetractions() throws {
        let withRetractions = """
        {"taskStatus":null,"messages":[],"refreshed":[],
         "superseded":["old-notice-id"],"nextCursor":null,"hasMore":false,"activity":[]}
        """.data(using: .utf8)!
        let updates = try JSONDecoder().decode(ChatUpdates.self, from: withRetractions)
        XCTAssertEqual(updates.superseded, ["old-notice-id"])

        // A server build from before retractions must still decode.
        let withoutRetractions = """
        {"taskStatus":null,"messages":[],"refreshed":[],
         "nextCursor":null,"hasMore":false,"activity":[]}
        """.data(using: .utf8)!
        let legacy = try JSONDecoder().decode(ChatUpdates.self, from: withoutRetractions)
        XCTAssertNil(legacy.superseded)
    }

    func testDecodesCompanionCuesAndQuickReplies() throws {
        let data = #"{"id":"1","role":"assistant","parts":[{"type":"text","text":"Ready."},{"type":"data-face","data":{"state":"warm_smile"}},{"type":"data-theme","data":{"name":"cool_sky"}},{"type":"data-chips","data":{"labels":["Show me","Continue"]}}]}"#.data(using: .utf8)!
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertEqual(message.text, "Ready.")
        XCTAssertEqual(message.face, .warmSmile)
        XCTAssertEqual(message.mood, .coolSky)
        XCTAssertEqual(message.quickReplies, ["Show me", "Continue"])
    }

    func testKnowledgeOverviewDoesNotPromoteAnAutomaticSelection() {
        let address = KnowledgeEntity(
            id: "address", label: "1 Daniel Burnham Court", kind: "place",
            canonicalKey: "place:address")
        let overview = KnowledgeOverview(
            totalEntities: 1, totalRelations: 0, unreviewedRelations: 0,
            entities: [address], matchingEntities: 1, entityPage: 1, entityPages: 1,
            selected: address, relations: [], selectedActiveRelationTotal: 0, duplicates: [])

        XCTAssertNil(overview.entitySelected(by: nil), "Opening or returning to browse must not feature the API default")
        XCTAssertEqual(overview.entitySelected(by: address.id), address)
        XCTAssertNil(overview.entitySelected(by: "another-item"), "A stale response must not show a different item")
    }

    func testRelationshipEditorIncludesExtendedFamily() {
        let options = KnowledgeConnectionEditor.relationshipOptions(subjectKind: "person", objectKind: "person")
        let ids = Set(options.map(\.id))
        for role in ["father", "mother", "child", "brother", "sister", "grandmother", "grandfather", "grandparent", "grandchild", "grandson", "granddaughter", "aunt", "uncle", "niece", "nephew", "cousin", "partner"] {
            XCTAssertTrue(ids.contains("\(role)_of"), "Missing \(role)")
        }
        XCTAssertEqual(options.first { $0.id == "grandmother_of" }?.label, "is the grandmother of")
        XCTAssertFalse(KnowledgeConnectionEditor.relationshipOptions(subjectKind: "person", objectKind: "place").contains { $0.id == "grandmother_of" })
    }

    func testRelationshipEditorPreviewPreservesDirection() {
        for (predicate, role) in [("son_of", "son"), ("daughter_of", "daughter"), ("parent_of", "parent"), ("grandmother_of", "grandmother"), ("grandchild_of", "grandchild")] {
            XCTAssertEqual(
                KnowledgeConnectionEditor.previewSentence(subject: "Alex", predicate: predicate, objectLabel: "Robin"),
                "Alex is Robin’s \(role).")
        }
    }

    func testDecodesKnowledgeRelationshipPresentation() throws {
        let data = """
        {
          "totalEntities":2,"totalRelations":1,"unreviewedRelations":1,
          "entities":[{"id":"baldvin","label":"Baldvin","kind":"person","canonicalKey":"person:baldvin"}],
          "matchingEntities":2,"entityPage":1,"entityPages":1,
          "selected":{"id":"baldvin","label":"Baldvin","kind":"person","canonicalKey":"person:baldvin"},
          "relations":[{
            "id":"edge-1",
            "subject":{"id":"baldvin","label":"Baldvin","kind":"person","canonicalKey":"person:baldvin"},
            "predicate":"daughter_of",
            "object":{"id":"freyja","label":"Freyja_Ruth","kind":"person","canonicalKey":"person:freyja"},
            "confidence":0.92,"reviewStatus":"unreviewed","validFrom":null,"validUntil":null,"inRecall":true,
            "source":{"memoryId":"memory-1","content":"Freyja is Baldvin's daughter.","createdAt":"2026-08-27T00:00:00.000Z","ownerConfirmed":true,"originTrust":"owner"},
            "presentation":{"sentence":"Freyja Ruth is Baldvin's daughter.","label":"Daughter","accessibleLabel":"Freyja Ruth is Baldvin's daughter."}
          }],
          "selectedActiveRelationTotal":1,"duplicates":[]
        }
        """.data(using: .utf8)!

        let overview = try JSONDecoder().decode(KnowledgeOverview.self, from: data)
        XCTAssertEqual(overview.selected?.displayLabel, "Baldvin")
        XCTAssertEqual(overview.relations.first?.object.displayLabel, "Freyja Ruth")
        XCTAssertEqual(overview.relations.first?.presentation.sentence, "Freyja Ruth is Baldvin's daughter.")
        let relation = try XCTUnwrap(overview.relations.first)
        XCTAssertEqual(relation.connectedEntity(to: "baldvin")?.id, "freyja")
        XCTAssertEqual(relation.connectedEntity(to: "freyja")?.id, "baldvin")
        XCTAssertNil(relation.connectedEntity(to: "unrelated"))
        XCTAssertEqual(relation.predicate, "daughter_of", "Exploring must not reverse the underlying fact")
        let duplicate = KnowledgeRelation(id: "edge-2", subject: relation.subject, predicate: relation.predicate,
            object: relation.object, confidence: 0.9, reviewStatus: "confirmed", validFrom: nil, validUntil: nil,
            inRecall: true, source: relation.source, presentation: relation.presentation)
        let groups = KnowledgeConnection.group([relation, duplicate])
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups.first?.sources.count, 2)
        XCTAssertEqual(groups.first?.confirmed, true)
        XCTAssertEqual(KnowledgeConnection.group([relation]).first?.confirmed, false)
        XCTAssertEqual(KnowledgeConnection.group([duplicate, relation]).first?.id, groups.first?.id)
    }

    func testMoodStaysDefaultRegardlessOfThemeCues() {
        let themed = ChatMessage(
            id: "themed",
            role: .assistant,
            parts: [.init(type: "data-theme", data: .object(["name": .string("cool_sky")]))]
        )
        let plain = { (index: Int) in
            ChatMessage.optimistic(role: .assistant, text: "Working", id: "a\(index)")
        }

        let atEdge = [themed] + (0..<(CompanionMood.lookback - 1)).map(plain)
        XCTAssertEqual(CompanionMood.latest(in: atEdge), .default)

        let asLastMessage = [themed]
        XCTAssertEqual(CompanionMood.latest(in: asLastMessage), .default)
    }

    func testMoodIgnoresThemeCuesMixedWithOwnerMessages() {
        let themed = ChatMessage(
            id: "themed",
            role: .assistant,
            parts: [.init(type: "data-theme", data: .object(["name": .string("soft_rose")]))]
        )
        let owner = (0..<40).map { ChatMessage.optimistic(role: .user, text: "Thanks", id: "u\($0)") }

        XCTAssertEqual(CompanionMood.latest(in: [themed] + owner), .default)
        XCTAssertEqual(CompanionMood.latest(in: []), .default)
    }

    func testOptimisticMessageUsesLocalIdentity() {
        let message = ChatMessage.optimistic(role: .user, text: "Hello")
        XCTAssertTrue(message.id.hasPrefix("local-"))
        XCTAssertEqual(message.text, "Hello")
    }

    private func persisted(
        _ id: String,
        _ role: ChatRole,
        _ text: String,
        at sentAt: String
    ) -> ChatMessage {
        ChatMessage(
            id: id,
            role: role,
            parts: [.init(type: "text", text: text)],
            metadata: ["createdAt": .string(sentAt)]
        )
    }

    func testChatLogPutsDurableTwinsBackWhereTheyWereAsked() {
        var order = ChatLogOrder()
        // Three turns typed while the assistant worked. Their durable twins
        // arrive later, and a merge can only append them.
        let typed = [
            "Anything on my calendar for tomorrow?",
            "Check all calendars",
            "How will the weather be tomorrow?",
        ].map { ChatMessage.optimistic(role: .user, text: $0) }
        var log = order.ordered(
            [persisted("m0", .assistant, "Morning.", at: "2026-08-27T09:00:00.000Z")] + typed
        )
        XCTAssertEqual(log.map(\.id), ["m0"] + typed.map(\.id))

        // The replies land first — they are what the poll returns.
        log = order.ordered(log + [
            persisted("a1", .assistant, "Two things today.", at: "2026-08-27T09:00:20.000Z"),
            persisted("a2", .assistant, "All three calendars are clear.", at: "2026-08-27T09:00:40.000Z"),
        ])
        XCTAssertEqual(log.map(\.id), ["m0"] + typed.map(\.id) + ["a1", "a2"])

        // Then a refresh returns the durable user rows, appended at the end.
        let durable = [
            persisted("u1", .user, typed[0].text, at: "2026-08-27T09:00:10.000Z"),
            persisted("u2", .user, typed[1].text, at: "2026-08-27T09:00:30.000Z"),
            persisted("u3", .user, typed[2].text, at: "2026-08-27T09:00:50.000Z"),
        ]
        log = order.ordered(log.filter { !$0.id.hasPrefix("local-") } + durable)
        // Each question back above the reply that answered it.
        XCTAssertEqual(log.map(\.id), ["m0", "u1", "a1", "u2", "a2", "u3"])
    }

    func testChatLogKeepsAnUnsentTurnAboveTheReplyArrivingUnderIt() {
        var order = ChatLogOrder()
        let question = ChatMessage.optimistic(role: .user, text: "How will the weather be?")
        var log = order.ordered([
            persisted("m0", .user, "Morning.", at: "2026-08-27T09:00:00.000Z"),
            question,
        ])
        XCTAssertEqual(log.map(\.id), ["m0", question.id])

        // A question whose durable twin has not come back yet still sits above
        // the reply answering it: the reply's send time is later than the log
        // the question anchored to, and no device clock is consulted.
        log = order.ordered(log + [
            persisted("a1", .assistant, "Sunny.", at: "2026-08-27T09:00:05.000Z"),
        ])
        XCTAssertEqual(log.map(\.id), ["m0", question.id, "a1"])

        // The live bubble is written last and stays last.
        let streaming = ChatMessage.optimistic(role: .assistant, text: "", id: "stream-1")
        XCTAssertEqual(
            order.ordered(log + [streaming]).map(\.id),
            ["m0", question.id, "a1", "stream-1"]
        )
    }

    func testChatLogOrdersMessagesSharingASendTimeByIdLikeTheServer() {
        var order = ChatLogOrder()
        let log = order.ordered([
            persisted("b", .assistant, "Second", at: "2026-08-27T09:00:00.000Z"),
            persisted("a", .user, "First", at: "2026-08-27T09:00:00.000Z"),
        ])
        XCTAssertEqual(log.map(\.id), ["a", "b"])
    }

    func testDecisionMessageUsesOnlyItsStructuredCardAndTracksResolution() throws {
        let pendingData = """
        {"id":"approval-message","role":"assistant","parts":[
          {"type":"text","text":"This needs your approval before I act: A7"},
          {"type":"approval","approvalId":"approval-1","shortCode":"A7","summary":"Search the web","status":"pending"}
        ]}
        """.data(using: .utf8)!
        let pending = try JSONDecoder().decode(ChatMessage.self, from: pendingData)
        XCTAssertEqual(pending.decisionParts.count, 1)
        XCTAssertTrue(pending.visibleTextBubbles.isEmpty)
        XCTAssertTrue(pending.hasPendingDecision)

        let approvedData = """
        {"id":"approval-message","role":"assistant","parts":[
          {"type":"text","text":"This needs your approval before I act: A7"},
          {"type":"approval","approvalId":"approval-1","shortCode":"A7","summary":"Search the web","status":"approved"}
        ]}
        """.data(using: .utf8)!
        let approved = try JSONDecoder().decode(ChatMessage.self, from: approvedData)
        XCTAssertFalse(approved.hasPendingDecision)
    }

    func testSuggestionPartDecodesAsAnOpenQuestionBesideItsProse() throws {
        let data = Data("""
        {"id":"suggestion-message","role":"assistant","parts":[
          {"type":"text","text":"One more thing from your \\"Flights\\" watch:"},
          {"type":"suggestion","suggestionId":"s1","summary":"Fares to Lisbon dropped — want me to hold one?",
           "proposedAction":"Hold the cheapest Lisbon fare"}
        ]}
        """.utf8)
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        let part = try XCTUnwrap(message.suggestionParts.first)

        XCTAssertEqual(part.suggestionId, "s1")
        XCTAssertEqual(part.summary, "Fares to Lisbon dropped — want me to hold one?")
        XCTAssertEqual(part.proposedAction, "Hold the cheapest Lisbon fare")
        XCTAssertNil(part.acceptedTaskId)
        XCTAssertEqual(part.suggestionStatus, .pending, "A part the server has not hydrated is a live question")
        XCTAssertTrue(part.suggestionStatus.isOpen)
        XCTAssertTrue(message.hasUnsettledSuggestion)
        // The prose explains the card, so it stays; and a background proposal
        // is not the answer to whatever the owner asked last.
        XCTAssertEqual(message.visibleTextBubbles, ["One more thing from your \"Flights\" watch:"])
        XCTAssertFalse(message.isConversationAnswer)
    }

    func testPendingSuggestionNeverCountsAsAPendingDecision() {
        let message = ChatMessage(id: "m", role: .assistant, parts: [
            .init(type: "text", text: "Your briefing."),
            .init(type: "suggestion", suggestionId: "s1", summary: "Book the dentist?", status: "pending"),
            .init(type: "suggestion", suggestionId: "s2", summary: "Renew the passport?"),
        ])
        XCTAssertEqual(message.suggestionParts.count, 2)
        XCTAssertTrue(message.decisionParts.isEmpty)
        XCTAssertFalse(message.hasPendingDecision)
        XCTAssertNil(message.approvalSummary)
        XCTAssertFalse(message.isApprovedApprovalReceipt)
        XCTAssertEqual(
            [message, message].transcriptItems().count, 2,
            "A suggestion row must never fold into an approved-receipt run"
        )
    }

    func testSettledSuggestionStatusesCloseTheCard() throws {
        let cases: [(String, SuggestionStatus, Bool)] = [
            ("accepted", .accepted, true),
            ("dismissed", .dismissed, false),
            // A snooze still sleeping settles, but is read back until it lapses.
            ("snoozed", .snoozed, true),
            ("expired", .expired, false),
            ("missing", .missing, false),
            ("something-new", .missing, false),
        ]
        for (raw, expected, unsettled) in cases {
            let data = Data("""
            {"id":"m","role":"assistant","parts":[
              {"type":"suggestion","suggestionId":"s1","summary":"Book the dentist?",
               "proposedAction":"Book a check-up","status":"\(raw)","acceptedTaskId":"task-7"}
            ]}
            """.utf8)
            let message = try JSONDecoder().decode(ChatMessage.self, from: data)
            let part = try XCTUnwrap(message.suggestionParts.first)
            XCTAssertEqual(part.suggestionStatus, expected, raw)
            XCTAssertFalse(part.suggestionStatus.isOpen, raw)
            XCTAssertEqual(message.hasUnsettledSuggestion, unsettled, raw)
            XCTAssertEqual(part.acceptedTaskId, "task-7")
        }
    }

    func testSuggestionWithoutAnIdIsNotDrawn() {
        let message = ChatMessage(id: "m", role: .assistant, parts: [
            .init(type: "suggestion", summary: "Nothing to answer this with"),
        ])
        XCTAssertTrue(message.suggestionParts.isEmpty)
        XCTAssertFalse(message.hasUnsettledSuggestion)
    }

    func testHydratedSnoozeKeepsItsServerTimeAndFormatsItInTheReadersZone() throws {
        for timestamp in ["2026-10-03T01:30:00.000Z", "2026-10-03T01:30:00Z", "2026-10-02T18:30:00-07:00"] {
            let data = Data("""
            {"id":"m","role":"assistant","parts":[
              {"type":"suggestion","suggestionId":"s1","status":"snoozed","snoozedUntil":"\(timestamp)"}
            ]}
            """.utf8)
            let message = try JSONDecoder().decode(ChatMessage.self, from: data)
            let part = try XCTUnwrap(message.suggestionParts.first)
            XCTAssertEqual(part.snoozedUntil, timestamp)
            XCTAssertEqual(try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(message)), message)
            let receipt = SuggestionReceiptPresentation(part: part)
            XCTAssertEqual(receipt.title, "Snoozed")
            XCTAssertNotNil(receipt.returnDate)
            let utc = try XCTUnwrap(receipt.returnLabel(locale: Locale(identifier: "en_US"), timeZone: TimeZone(secondsFromGMT: 0)!))
            let local = try XCTUnwrap(receipt.returnLabel(locale: Locale(identifier: "en_US"), timeZone: TimeZone(identifier: "America/Los_Angeles")!))
            XCTAssertTrue(utc.contains("Oct 3, 2026"), utc)
            XCTAssertTrue(local.contains("Oct 2, 2026"), local)
            XCTAssertTrue(local.contains("6:30"), local)
            XCTAssertFalse(part.suggestionStatus.isOpen, "Only server hydration can reopen the suggestion")
        }
    }

    func testMissingOrMalformedSnoozeTimeNeverInventsAReturnDate() throws {
        for suffix in ["", ",\"snoozedUntil\":null", ",\"snoozedUntil\":\"not-a-date\""] {
            let data = Data("{\"type\":\"suggestion\",\"suggestionId\":\"s1\",\"status\":\"snoozed\"\(suffix)}".utf8)
            let part = try JSONDecoder().decode(MessagePart.self, from: data)
            let receipt = SuggestionReceiptPresentation(part: part)
            XCTAssertEqual(part.suggestionStatus, .snoozed)
            XCTAssertNil(receipt.returnDate)
            XCTAssertEqual(receipt.returnLabel(), "Return time unavailable")
        }
        for status in ["pending", "accepted", "dismissed", "expired", "missing"] {
            let part = MessagePart(type: "suggestion", suggestionId: "s1", status: status, snoozedUntil: "2026-10-03T01:30:00Z")
            XCTAssertNil(SuggestionReceiptPresentation(part: part).returnLabel(), "A stale deadline cannot give \(status) a return promise")
        }
        XCTAssertEqual(SuggestionReceiptPresentation(part: .init(type: "suggestion", status: "pending")).title, "Suggested next step")
    }

    func testUnknownSnoozeAcknowledgesOnceAndLetsLaterServerReadsPrevail() {
        let message = ChatMessage(id: "m", role: .assistant, parts: [
            .init(type: "suggestion", suggestionId: "s1", status: "pending")
        ])
        let answer = ["s1": SuggestionAnswer(decision: .snoozed)]
        let acknowledged = message.applyingSuggestionAnswers(answer, acknowledging: true)
        XCTAssertEqual(acknowledged.parts[0].suggestionStatus, .snoozed)
        XCTAssertEqual(SuggestionReceiptPresentation(part: acknowledged.parts[0]).returnLabel(), "Return time unavailable")
        XCTAssertEqual(message.applyingSuggestionAnswers(answer), message, "A legacy acknowledgement cannot mask later pending reads forever")
    }

    func testAcknowledgedSnoozeSuppliesOnlyMissingDeadlineAndRetainsSourceAuthority() {
        let now = Date(timeIntervalSince1970: 1_000)
        let until = now.addingTimeInterval(60)
        let answer = ["s1": SuggestionAnswer(decision: .snoozed, snoozedUntil: until)]
        let message = ChatMessage(id: "m", role: .assistant, parts: [RichMessageFixture.suggestion])
        let overlaid = message.applyingSuggestionAnswers(answer, now: now)
        XCTAssertEqual(SuggestionReceiptPresentation(part: overlaid.parts[0]).returnDate, until)
        XCTAssertEqual(overlaid.parts[0].contextCard, message.parts[0].contextCard)
        XCTAssertEqual(overlaid.parts[0].actionLabel, message.parts[0].actionLabel)
        XCTAssertEqual(overlaid.parts[0].summary, message.parts[0].summary)
        var hydrated = overlaid
        hydrated.parts[0].snoozedUntil = ISO8601DateFormatter.assistant.string(from: until.addingTimeInterval(120))
        XCTAssertEqual(hydrated.applyingSuggestionAnswers(answer, now: now), hydrated, "A hydrated current deadline wins over a device shadow")
        XCTAssertEqual(message.applyingSuggestionAnswers(answer, now: until), message)
    }

    func testLocalAnswersCannotOverwriteConflictingTerminalServerState() {
        for status in ["accepted", "dismissed", "expired", "missing", "future-status"] {
            for decision in [SuggestionDecision.accepted, .dismissed, .snoozed] where status != decision.rawValue {
                let message = ChatMessage(id: "m", role: .assistant, parts: [
                    .init(type: "suggestion", suggestionId: "s1", status: status, acceptedTaskId: "server-task")
                ])
                let answer = SuggestionAnswer(decision: decision, taskId: "local-task", snoozedUntil: .distantFuture)
                XCTAssertEqual(message.applyingSuggestionAnswers(["s1": answer]), message, "\(status) must prevail over local \(decision)")
            }
        }
    }

    func testSuggestionReceiptReflectsActualTaskProgress() throws {
        let data = Data(#"{"id":"m","role":"assistant","parts":[{"type":"suggestion","suggestionId":"s1","status":"accepted","acceptedTaskId":"t1","acceptedTaskStatus":"completed","acceptedTaskSummary":"Reviewed the report; no reply was needed."}]}"#.utf8)
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertEqual(message.suggestionParts.first?.acceptedTaskStatus, "completed")
        XCTAssertEqual(message.suggestionParts.first?.acceptedTaskSummary, "Reviewed the report; no reply was needed.")
        XCTAssertEqual(SuggestionTaskReceipt.title(for: "completed"), "Completed")
        XCTAssertEqual(SuggestionTaskReceipt.title(for: "done"), "Completed")
        XCTAssertEqual(SuggestionTaskReceipt.title(for: "running"), "Working on it")
        XCTAssertEqual(SuggestionTaskReceipt.title(for: "queued"), "Queued")
        XCTAssertEqual(SuggestionTaskReceipt.title(for: "pending"), "Queued")
        XCTAssertEqual(SuggestionTaskReceipt.title(for: "sleeping"), "Waiting")
        XCTAssertEqual(SuggestionTaskReceipt.title(for: "waiting_event"), "Waiting")
        XCTAssertEqual(SuggestionTaskReceipt.title(for: "cancelled"), "Cancelled")
        for status in ["failed", "dead"] {
            XCTAssertEqual(SuggestionTaskReceipt.title(for: status), "Couldn’t complete")
        }
        for status in ["waiting_approval", "waiting_budget", "needs_attention"] {
            XCTAssertEqual(SuggestionTaskReceipt.title(for: status), "Needs attention")
        }
        XCTAssertEqual(SuggestionTaskReceipt.title(for: nil), "Accepted")
        XCTAssertEqual(SuggestionTaskReceipt.title(for: "future-status"), "Accepted")
        let overlaid = message.applyingSuggestionAnswers(["s1": .init(decision: .accepted, taskId: "t1")])
        XCTAssertEqual(overlaid.suggestionParts.first?.acceptedTaskStatus, "completed")
        XCTAssertEqual(overlaid.suggestionParts.first?.acceptedTaskSummary, "Reviewed the report; no reply was needed.")
        XCTAssertFalse(overlaid.hasUnsettledSuggestion)
        for status in ["pending", "running", "waiting_approval", "waiting_event", "sleeping", "waiting_budget", "needs_attention", "done", "failed", "cancelled"] {
            var updated = message
            updated.parts[0].acceptedTaskStatus = status
            XCTAssertEqual(updated.hasUnsettledSuggestion, !["done", "failed", "cancelled"].contains(status), status)
        }
    }

    func testLocalSnoozeEndsOnTimeAndCannotOverwriteTerminalServerAnswers() {
        let now = Date(timeIntervalSince1970: 1_000)
        let answer = SuggestionAnswer(decision: .snoozed, snoozedUntil: now.addingTimeInterval(60))
        for status in ["pending", "snoozed", "accepted", "dismissed", "expired", "missing"] {
            let message = ChatMessage(id: "m", role: .assistant, parts: [
                .init(type: "suggestion", suggestionId: "s1", status: status)
            ])
            let beforeWake = message.applyingSuggestionAnswers(["s1": answer], now: now)
            XCTAssertEqual(beforeWake.parts[0].status, status == "pending" ? "snoozed" : status)
            XCTAssertEqual(message.applyingSuggestionAnswers(["s1": answer], now: now.addingTimeInterval(60)), message)
        }
    }

    func testLocalSuggestionAnswerOutlivesAStaleReadAndTouchesNothingElse() {
        let stale = ChatMessage(id: "m", role: .assistant, parts: [
            .init(type: "text", text: "Your briefing."),
            .init(type: "suggestion", suggestionId: "s1", summary: "Book the dentist?", status: "pending"),
            .init(type: "suggestion", suggestionId: "s2", summary: "Renew the passport?", status: "pending"),
            .init(type: "approval", approvalId: "s1", status: "pending"),
        ])
        let answered = stale.applyingSuggestionAnswers(["s1": .init(decision: .accepted, taskId: "t1")])
        XCTAssertEqual(answered.parts[1].suggestionStatus, .accepted)
        XCTAssertEqual(answered.parts[1].acceptedTaskId, "t1")
        XCTAssertEqual(answered.parts[2].suggestionStatus, .pending)
        XCTAssertEqual(answered.parts[3].status, "pending", "An approval sharing the id is not a suggestion")
        XCTAssertEqual(answered.text, "Your briefing.")
        XCTAssertEqual(answered.applyingSuggestionAnswers(["s1": .init(decision: .accepted, taskId: "t1")]), answered)

        // The server's own task id survives an answer held before it was known.
        let hydrated = ChatMessage(id: "m", role: .assistant, parts: [
            .init(type: "suggestion", suggestionId: "s1", status: "accepted", acceptedTaskId: "t1"),
        ])
        XCTAssertEqual(
            hydrated.applyingSuggestionAnswers(["s1": .init(decision: .accepted)]).parts[0].acceptedTaskId, "t1"
        )
        XCTAssertEqual(
            hydrated.applyingSuggestionAnswers(["s1": .init(decision: .accepted, taskId: "older-task")]).parts[0].acceptedTaskId, "t1",
            "Hydrated task identity wins over a device shadow"
        )
        XCTAssertEqual(stale.applyingSuggestionAnswers([:]), stale)
    }

    func testApprovalSummaryUsesItsStructuredCardAndKeepsFallbackTextHidden() throws {
        let data = """
        {"id":"approval-summary-message","role":"assistant","parts":[
          {"type":"text","text":"Approval needed to continue: Find an open cafe nearby"},
          {"type":"approval-summary","purpose":"Find an open cafe nearby","approvalCount":4}
        ]}
        """.data(using: .utf8)!
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)

        XCTAssertEqual(message.approvalSummary?.purpose, "Find an open cafe nearby")
        XCTAssertEqual(message.approvalSummary?.approvalCount, 4)
        XCTAssertTrue(message.visibleTextBubbles.isEmpty)
    }

    func testTranscriptGroupsOnlyConsecutiveApprovedApprovalReceipts() {
        func receipt(_ id: String, status: String = "approved") -> ChatMessage {
            ChatMessage(
                id: id,
                role: .assistant,
                parts: [
                    .init(type: "text", text: "This needs your approval before I act."),
                    .init(type: "approval", approvalId: "approval-\(id)", summary: "Request \(id)", status: status),
                ]
            )
        }

        let user = ChatMessage.optimistic(role: .user, text: "Do the work", id: "user")
        let items = [user, receipt("one"), receipt("two"), receipt("pending", status: "pending"), receipt("three"), receipt("four")]
            .transcriptItems()

        XCTAssertEqual(items.count, 4)
        guard case let .approvedReceiptGroup(firstGroup, firstIndex) = items[1] else {
            return XCTFail("Expected the adjacent approved receipts to be grouped")
        }
        XCTAssertEqual(firstGroup.map(\.id), ["one", "two"])
        XCTAssertEqual(firstIndex, 1)
        guard case let .approvedReceiptGroup(secondGroup, firstIndex) = items[3] else {
            return XCTFail("Expected the later adjacent approved receipts to be grouped")
        }
        XCTAssertEqual(secondGroup.map(\.id), ["three", "four"])
        XCTAssertEqual(firstIndex, 4)
    }

    func testStructuredTaskNoticeDecodesForCardPresentation() throws {
        let data = """
        {"id":"notice-1","role":"assistant","parts":[
          {"type":"text","text":"The task stopped."},
          {"type":"notice","notice":"needs-attention"}
        ]}
        """.data(using: .utf8)!
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertEqual(message.noticeKind, .needsAttention)
    }

    func testKnowledgeGraphRecallProvenanceDecodesFromMessageParts() throws {
        let data = """
        {"id":"reply-1","role":"assistant","parts":[
          {"type":"text","text":"Here is the answer."},
          {"type":"recall","sources":[
            {"date":"2026-08-24","label":"Works at Acme","kind":"knowledge_graph","hops":2,"surfaceKey":"\(String(repeating: "a", count: 64))","sourceRevision":"\(String(repeating: "b", count: 64))"},
            {"date":"2026-08-25","label":"Chose Portland","kind":"situation_decision","hops":1,"surfaceKey":"\(String(repeating: "c", count: 64))","sourceRevision":"\(String(repeating: "d", count: 64))"},
            {"date":"2026-08-26","label":"Find a venue","kind":"commitment","hops":1,"surfaceKey":"\(String(repeating: "e", count: 64))","sourceRevision":"\(String(repeating: "f", count: 64))"},
            {"date":"2026-08-27","label":"Future source","kind":"new_kind","hops":1}
          ]}
        ]}
        """.data(using: .utf8)!
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertEqual(message.recallSources.count, 4)
        XCTAssertTrue(message.recallSources[0].isKnowledgeGraph)
        XCTAssertEqual(message.recallSources[0].hops, 2)
        XCTAssertTrue(message.recallSources[0].hasCurrentLedgerReference)
        XCTAssertEqual(message.recallSources[1].displayGroup, "saved decisions")
        XCTAssertEqual(message.recallSources[2].displayGroup, "commitments")
        XCTAssertEqual(message.recallSources[3].displayGroup, "saved context")
        XCTAssertFalse(message.recallSources[3].hasCurrentLedgerReference)
    }

    func testResponseCardsUseStructuredPartsBeforeTextFallback() {
        let card = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("calendar"),
                "title": .string("Today"),
                "subtitle": .string("Thursday, August 23"),
                "items": .array([
                    .object([
                        "time": .string("9:30 AM"),
                        "title": .string("Design review"),
                        "detail": .string("Studio"),
                    ]),
                ]),
            ])
        )

        guard case let .agenda(title, subtitle, items)? = MessageResponseCard(part: card) else {
            return XCTFail("Expected a structured agenda card")
        }
        XCTAssertEqual(title, "Today")
        XCTAssertEqual(subtitle, "Thursday, August 23")
        XCTAssertEqual(items.first?.time, "9:30 AM")
        XCTAssertEqual(items.first?.title, "Design review")
    }

    func testGeneratedCardDecodesVersionedFactsAndSensitiveCodes() {
        let card = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("generated-card"),
                "id": .string("ticket-1"),
                "spec": .object([
                    "version": .number(1),
                    "title": .string("Movie ticket"),
                    "sourceLabel": .string("Cinema email"),
                    "accessibilityLabel": .string("Movie ticket for Dune"),
                    "facts": .array([
                        .object(["id": .string("movie"), "label": .string("Movie"), "value": .string("Dune: Part Two")]),
                        .object(["id": .string("code"), "label": .string("Ticket code"), "value": .string("MV-4829-AX"), "sensitive": .bool(true)]),
                    ]),
                    "blocks": .array([
                        .object(["type": .string("hero"), "titleFact": .string("movie")]),
                        .object(["type": .string("code"), "valueFact": .string("code")]),
                    ]),
                ]),
            ])
        )
        guard case let .generated(generated)? = MessageResponseCard(part: card) else {
            return XCTFail("Expected a generated card")
        }
        XCTAssertEqual(generated.title, "Movie ticket")
        XCTAssertEqual(generated.facts.first?.value, "Dune: Part Two")
        XCTAssertTrue(generated.facts.last?.sensitive == true)
        XCTAssertTrue(generated.steps.isEmpty)
    }

    func testGeneratedCardSectionCarriesItsLeafBlocks() {
        let card = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("generated-card"),
                "id": .string("flight-1"),
                "spec": .object([
                    "version": .number(1),
                    "title": .string("FI 614 to New York"),
                    "sourceLabel": .string("Icelandair email"),
                    "accessibilityLabel": .string("Flight FI 614"),
                    "facts": .array([
                        .object(["id": .string("gate"), "label": .string("Gate"), "value": .string("D4")]),
                        .object(["id": .string("seat"), "label": .string("Seat"), "value": .string("14A")]),
                    ]),
                    "blocks": .array([
                        .object([
                            "type": .string("section"),
                            "title": .string("At the airport"),
                            "blocks": .array([
                                .object(["type": .string("metrics"), "factIds": .array([.string("gate"), .string("seat")])]),
                                // Sections do not nest; a nested one is dropped, not drawn.
                                .object(["type": .string("section"), "title": .string("Nested"), "blocks": .array([])]),
                            ]),
                        ]),
                    ]),
                ]),
            ])
        )
        guard case let .generated(generated)? = MessageResponseCard(part: card),
              let section = generated.blocks.first else {
            return XCTFail("Expected a generated card with a section")
        }
        XCTAssertEqual(section.type, "section")
        XCTAssertEqual(section.children.map(\.type), ["metrics"])
        XCTAssertEqual(section.children.first?.values["factIds"]?.arrayStrings, ["gate", "seat"])
    }

    func testNativeGeneratedCardCatalogAcceptsEverySharedBlockRule() {
        let facts: [JSONValue] = [
            generatedFact("name", "Concert", label: "Name"),
            generatedFact("name2", "Festival", label: "Other"),
            generatedFact("number", "12", label: "Count"),
            generatedFact("number2", "18", label: "Total"),
            generatedFact("percent", "75%", label: "Progress"),
            generatedFact("date", "2026-10-07T12:00:00Z", label: "Date"),
            generatedFact("url", "https://example.com/photo.png", label: "Image"),
            generatedFact("place", "Central Park", label: "Place"),
        ]
        let validBlocks: [[String: JSONValue]] = [
            ["type": .string("hero"), "titleFact": .string("name"), "subtitleFact": .string("name2")],
            ["type": .string("facts"), "factIds": .array([.string("name")])],
            ["type": .string("timeline"), "factIds": .array([.string("name")])],
            ["type": .string("score"), "leftLabelFact": .string("name"), "leftValueFact": .string("number"), "rightLabelFact": .string("name2"), "rightValueFact": .string("number2"), "statusFact": .string("percent")],
            ["type": .string("code"), "valueFact": .string("name"), "format": .string("text")],
            ["type": .string("image"), "urlFact": .string("url"), "altFact": .string("name")],
            ["type": .string("note"), "factId": .string("name")],
            ["type": .string("metrics"), "factIds": .array([.string("number"), .string("number2")])],
            ["type": .string("journey"), "mode": .string("train"), "fromFact": .string("name"), "toFact": .string("name2")],
            ["type": .string("progress"), "valueFact": .string("percent")],
            ["type": .string("stages"), "factIds": .array([.string("name"), .string("name2")]), "currentFact": .string("name")],
            ["type": .string("countdown"), "dateFact": .string("date")],
            ["type": .string("table"), "columns": .array([.string("First"), .string("Second")]), "rows": .array([.array([.string("name"), .string("name2")])])],
            ["type": .string("chart"), "kind": .string("bar"), "points": .array([.object(["labelFact": .string("name"), "valueFact": .string("number")]), .object(["labelFact": .string("name2"), "valueFact": .string("number2")])])],
            ["type": .string("checklist"), "factIds": .array([.string("name")])],
            ["type": .string("map"), "placeFactIds": .array([.string("place")])],
        ]
        for block in validBlocks {
            XCTAssertTrue(nativeCardIsComplete(blocks: [.object(block)], facts: facts), "\(block["type"]?.string ?? "?") should follow the shared registry")
        }
        XCTAssertTrue(nativeCardIsComplete(blocks: [
            .object(["type": .string("section"), "title": .string("Details"), "blocks": .array([
                .object(["type": .string("note"), "factId": .string("name")]),
                .object(["type": .string("facts"), "factIds": .array([.string("name2")])]),
            ])]),
        ], facts: facts))
    }

    func testNativeGeneratedCardCatalogRejectsMalformedShapesAndPrivateComputedValues() {
        let facts: [JSONValue] = [
            generatedFact("a", "12", label: "A"),
            generatedFact("b", "18", label: "B"),
            generatedFact("private", "64.1, -21.9", label: "Private coordinates", sensitive: true),
            generatedFact("date", "2026-10-07T12:00:00Z", label: "Date"),
            generatedFact("wall-clock", "7:00 PM", label: "Unzoned time"),
            generatedFact("image", "https://user:secret@example.com/image.png", label: "Image"),
        ]
        let badBlocks: [[String: JSONValue]] = [
            ["type": .string("hero"), "titleFact": .string("missing")],
            ["type": .string("hero"), "titleFact": .string("a"), "subtitleFact": .string("missing")],
            ["type": .string("code"), "valueFact": .string("a"), "format": .string("qr-code")],
            ["type": .string("journey"), "mode": .string("spaceship"), "fromFact": .string("a"), "toFact": .string("b")],
            ["type": .string("facts"), "factIds": .array((0..<9).map { .string($0 == 0 ? "a" : "b") })],
            ["type": .string("table"), "columns": .array([.string("A"), .string("B")]), "rows": .array([.array([.string("a")])])],
            ["type": .string("table"), "columns": .array([.string("A"), .string("B")]), "rows": .array([.array([.string("a"), .string("missing")])])],
            ["type": .string("table"), "columns": .array(Array(repeating: .string("Column"), count: 5)), "rows": .array([.array(Array(repeating: .string("a"), count: 5))])],
            ["type": .string("table"), "columns": .array([.string("A"), .string("B")]), "rows": .array([])],
            ["type": .string("chart"), "kind": .string("pie"), "points": .array([.object(["labelFact": .string("a"), "valueFact": .string("a")]), .object(["labelFact": .string("b"), "valueFact": .string("b")])])],
            ["type": .string("chart"), "kind": .string("bar"), "points": .array([.object(["labelFact": .string("a"), "valueFact": .string("date")]), .object(["labelFact": .string("b"), "valueFact": .string("b")])])],
            ["type": .string("chart"), "kind": .string("bar"), "points": .array([.object(["labelFact": .string("a"), "valueFact": .string("private")]), .object(["labelFact": .string("b"), "valueFact": .string("b")])])],
            ["type": .string("chart"), "kind": .string("bar"), "points": .array(Array(repeating: .object(["labelFact": .string("a"), "valueFact": .string("b")]), count: 13))],
            ["type": .string("metrics"), "factIds": .array([.string("a"), .string("b"), .string("private"), .string("date"), .string("image")])],
            ["type": .string("map"), "placeFactIds": .array([.string("private")])],
            ["type": .string("map"), "placeFactIds": .array(Array(repeating: .string("a"), count: 7))],
            ["type": .string("progress"), "valueFact": .string("private")],
            ["type": .string("progress"), "valueFact": .string("a")],
            ["type": .string("countdown"), "dateFact": .string("wall-clock")],
            ["type": .string("image"), "urlFact": .string("image")],
            ["type": .string("section"), "title": .string(String(repeating: "x", count: 61)), "blocks": .array([.object(["type": .string("note"), "factId": .string("a")])])],
            ["type": .string("section"), "title": .string("Too many"), "blocks": .array(Array(repeating: .object(["type": .string("note"), "factId": .string("a")]), count: 7))],
            ["type": .string("section"), "title": .string("Nested"), "blocks": .array([.object(["type": .string("section"), "title": .string("Child"), "blocks": .array([.object(["type": .string("note"), "factId": .string("a")])])])])],
        ]
        for block in badBlocks {
            XCTAssertFalse(nativeCardIsComplete(blocks: [.object(block)], facts: facts), "malformed \(block["type"]?.string ?? "?") must keep the answer prose")
        }
        XCTAssertFalse(nativeCardIsComplete(blocks: [.object(["type": .string("facts"), "factIds": .array([.string("unknown")])])], facts: facts))
        XCTAssertFalse(nativeCardIsComplete(blocks: [.object(["type": .string("toString")])], facts: facts))
        XCTAssertFalse(nativeCardIsComplete(blocks: [.string("malformed block")], facts: facts))
        XCTAssertFalse(nativeCardIsComplete(blocks: [.object(["type": .string("note"), "factId": .string("a")])], facts: facts + [generatedFact("a", "duplicate", label: "Duplicate")]))
        XCTAssertFalse(nativeCardIsComplete(blocks: [.object(["type": .string("note"), "factId": .string("a")])], facts: facts, extraSpec: ["title": .string(String(repeating: "t", count: 101))]))
        XCTAssertFalse(nativeCardIsComplete(blocks: [.object(["type": .string("note"), "factId": .string("a")])], facts: facts, extraSpec: ["actions": .array([.object(["id": .string("bad id"), "type": .string("copy_value"), "label": .string("Copy"), "factId": .string("a")])])]))
        XCTAssertFalse(nativeCardIsComplete(blocks: [.object(["type": .string("note"), "factId": .string("a")])], facts: facts, extraSpec: ["actions": .array([.object(["id": .string("action"), "type": .string("add_to_calendar"), "label": .string("Add"), "startFact": .string("missing")])])]))
        XCTAssertFalse(nativeCardIsComplete(blocks: [.object(["type": .string("note"), "factId": .string("a")])], facts: facts, extraSpec: ["actions": .array(Array(repeating: .object(["id": .string("action"), "type": .string("refresh"), "label": .string("Refresh")]), count: 7))]))
    }

    func testMalformedWireBlockCannotDisappearBeforeNativeCompletenessDecision() {
        let spec: [String: JSONValue] = [
            "version": .number(1),
            "title": .string("Card title"),
            "sourceLabel": .string("Calendar"),
            "accessibilityLabel": .string("Calendar card"),
            "facts": .array([generatedFact("event", "Review", label: "Event")]),
            "blocks": .array([
                .object(["type": .string("hero"), "titleFact": .string("event")]),
                .string("malformed sibling"),
            ]),
        ]
        let part = MessagePart(type: "data-card", data: .object([
            "kind": .string("generated-card"), "id": .string("card"), "spec": .object(spec),
        ]))
        guard case let .generated(card)? = MessageResponseCard(part: part) else {
            return XCTFail("The malformed sibling must not prevent safe decoding of the card itself")
        }
        XCTAssertEqual(card.blocks.count, 1, "The presentation model may omit an unrenderable item")
        XCTAssertFalse(card.hasCompleteNativeComposition, "Admission must inspect the original wire spec")
        XCTAssertFalse(MessageResponseCard.replacesProse([.generated(card)]))
    }

    func testNativeGeneratedCardSpecChecksCoreCountAndFactBounds() {
        let oneBlock: [JSONValue] = [.object(["type": .string("note"), "factId": .string("event")])]
        let fact = generatedFact("event", "Review", label: "Event")
        XCTAssertFalse(nativeCardIsComplete(blocks: Array(repeating: oneBlock[0], count: 13), facts: [fact]))
        XCTAssertFalse(nativeCardIsComplete(blocks: oneBlock, facts: Array(repeating: fact, count: 41)))
        XCTAssertFalse(nativeCardIsComplete(blocks: oneBlock, facts: [.object(["id": .string("bad id"), "value": .string("Review"), "label": .string("Event"), "source": .string("Fixture source")])]))
        XCTAssertFalse(nativeCardIsComplete(blocks: oneBlock, facts: [.object(["id": .string("event"), "value": .string(String(repeating: "x", count: 501)), "label": .string("Event"), "source": .string("Fixture source")])]))
    }

    private func generatedFact(_ id: String, _ value: String, label: String, sensitive: Bool = false) -> JSONValue {
        .object([
            "id": .string(id), "value": .string(value), "label": .string(label),
            "source": .string("Fixture source"), "sensitive": .bool(sensitive),
        ])
    }

    private func nativeCardIsComplete(blocks: [JSONValue], facts: [JSONValue], extraSpec: [String: JSONValue] = [:]) -> Bool {
        var spec: [String: JSONValue] = [
            "version": .number(1), "title": .string("Fixture card"),
            "sourceLabel": .string("Fixture source"), "accessibilityLabel": .string("Fixture card"),
            "facts": .array(facts), "blocks": .array(blocks),
        ]
        spec.merge(extraSpec) { _, new in new }
        return NativeGeneratedCardCatalog.supportsComplete(spec: spec)
    }

    func testGeneratedCardValuesReadOnlyWhatTheServerAdmits() {
        XCTAssertEqual(GeneratedCardValue.number("1,190 USD"), 1190)
        XCTAssertEqual(GeneratedCardValue.number("$38.50"), 38.5)
        XCTAssertEqual(GeneratedCardValue.number("-3 °C"), -3)
        XCTAssertNil(GeneratedCardValue.number("Gate D4"))
        XCTAssertNil(GeneratedCardValue.number("1 hour 15 minutes"))

        XCTAssertEqual(GeneratedCardValue.fraction(value: "3", total: "5"), 0.6)
        XCTAssertEqual(GeneratedCardValue.fraction(value: "76%", total: nil), 0.76)
        XCTAssertNil(GeneratedCardValue.fraction(value: "140%", total: nil))
        XCTAssertNil(GeneratedCardValue.fraction(value: "6", total: "5"))

        let departure = GeneratedCardValue.instant("2026-10-02T16:40:00+00:00")
        XCTAssertEqual(departure?.zone.secondsFromGMT(), 0)
        XCTAssertEqual(GeneratedCardValue.instant("2026-10-02T09:40:00-07:00")?.zone.secondsFromGMT(), -7 * 3600)
        XCTAssertEqual(departure?.date, GeneratedCardValue.instant("2026-10-02T09:40:00-07:00")?.date)
        XCTAssertNil(GeneratedCardValue.instant("7:40 AM"))

        XCTAssertEqual(GeneratedCardValue.coordinate("64.1466, -21.9426")?.latitude, 64.1466)
        XCTAssertNil(GeneratedCardValue.coordinate("Laugavegur 1, Reykjavik"))
    }

    func testCardActionsOpenACalendarDraftAndShareWithoutSecrets() {
        let draft = CalendarDraft(
            identity: "card-1:add-calendar",
            title: "FI614 to New York",
            start: "2026-10-02T17:05:00+00:00",
            end: "2026-10-02T18:35:00-04:00",
            location: "Reykjavik (KEF)"
        )
        XCTAssertEqual(draft?.id, "card-1:add-calendar")
        XCTAssertEqual(draft?.timeZone.secondsFromGMT(), 0)
        XCTAssertEqual(draft.map { $0.end.timeIntervalSince($0.start) }, 5.5 * 3600)
        XCTAssertNil(CalendarDraft(title: "x", start: "16:40", end: nil, location: nil))
        XCTAssertEqual(
            CalendarDraft(title: "x", start: "2026-10-02T17:05:00Z", end: nil, location: nil)
                .map { $0.end.timeIntervalSince($0.start) },
            3600
        )
        XCTAssertEqual(
            GeneratedCardValue.directionsURL("Keflavik Int'l")?.absoluteString,
            "https://maps.apple.com/?daddr=Keflavik%20Int'l"
        )

        let card = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("generated-card"),
                "id": .string("ticket"),
                "spec": .object([
                    "version": .number(1),
                    "title": .string("Movie ticket"),
                    "sourceLabel": .string("Cinema email"),
                    "accessibilityLabel": .string("Movie ticket"),
                    "facts": .array([
                        .object(["id": .string("movie"), "label": .string("Movie"), "value": .string("Dune")]),
                        .object(["id": .string("when"), "label": .string("Showtime"), "value": .string("2026-10-02T19:30:00-07:00")]),
                        .object(["id": .string("code"), "label": .string("Ticket code"), "value": .string("MV-4829"), "sensitive": .bool(true)]),
                    ]),
                    "blocks": .array([.object(["type": .string("facts"), "factIds": .array([.string("movie")])])]),
                    "actions": .array([.object([
                        "id": .string("cal"), "type": .string("add_to_calendar"), "label": .string("Add to Calendar"),
                        "startFact": .string("when"),
                    ])]),
                ]),
            ])
        )
        guard case let .generated(generated)? = MessageResponseCard(part: card) else {
            return XCTFail("Expected a generated card")
        }
        XCTAssertEqual(generated.actions.first?.startFact, "when")
        let shared = GeneratedCardValue.shareText(generated)
        XCTAssertTrue(shared.hasPrefix("Movie ticket\nMovie: Dune"))
        XCTAssertFalse(shared.contains("MV-4829"))
        XCTAssertFalse(shared.contains("2026-10-02T19:30"), "times are shared on their own clock, not as ISO")
    }

    func testGeneratedCardCarriesTheStepsBehindIt() {
        let card = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("generated-card"),
                "id": .string("hotel-1"),
                "steps": .array([
                    .object([
                        "tool": .string("gmail.search"),
                        "count": .string("1 result"),
                        "detail": .string("from:Katie hotels.com 73535835545212"),
                    ]),
                    .object([
                        "tool": .string("calendar.search_events"),
                        "failed": .bool(true),
                        "error": .string("Calendar timed out"),
                    ]),
                    // A malformed step is dropped, never rendered as a blank row.
                    .object(["count": .string("1 result")]),
                ]),
                "spec": .object([
                    "version": .number(1),
                    "title": .string("Hotel Kabuki"),
                    "sourceLabel": .string("Hotel"),
                    "accessibilityLabel": .string("Hotel Kabuki reservation"),
                    "facts": .array([
                        .object(["id": .string("room"), "label": .string("Room"), "value": .string("King, garden view")]),
                    ]),
                    "blocks": .array([.object(["type": .string("hero"), "titleFact": .string("room")])]),
                ]),
            ])
        )
        guard case let .generated(generated)? = MessageResponseCard(part: card) else {
            return XCTFail("Expected a generated card")
        }
        XCTAssertEqual(generated.steps.count, 2)
        XCTAssertEqual(generated.steps.first?.count, "1 result")
        XCTAssertEqual(generated.steps.first?.detail, "from:Katie hotels.com 73535835545212")
        XCTAssertFalse(generated.steps.first?.failed ?? true)
        XCTAssertTrue(generated.steps.last?.failed ?? false)
        XCTAssertEqual(generated.steps.last?.error, "Calendar timed out")
    }

    func testStepLabelsReadAsCompletedWorkNeverAsToolNames() {
        XCTAssertEqual(ToolStepLabel.past(for: "gmail.search"), "Searched email")
        XCTAssertEqual(ToolStepLabel.past(for: "web.fetch"), "Read a web page")
        // A tool with no phrase of its own is named for what it touched.
        XCTAssertEqual(ToolStepLabel.past(for: "memory.graph_snapshot"), "Checked memory")
        XCTAssertEqual(ToolStepLabel.past(for: "custom_source.do_thing"), "Checked custom source")
    }

    func testNoticePresentationDecodesAdditively() throws {
        let data = #"{"id":"notice-1","role":"assistant","parts":[{"type":"text","text":"full diagnostic text"},{"type":"notice","notice":"needs-attention","presentation":{"version":1,"headline":"Choose locations","summary":"Remote only or specific cities?","facts":[{"label":"Goal","value":"Job search"}],"detailLabel":"Technical details","diagnostics":["web.fetch approval expired"]}}]}"#.data(using: .utf8)!
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertEqual(message.noticePresentation?.headline, "Choose locations")
        XCTAssertEqual(message.noticePresentation?.summary, "Remote only or specific cities?")
        XCTAssertEqual(message.noticePresentation?.facts?.first?.value, "Job search")
        XCTAssertEqual(message.noticePresentation?.diagnostics, ["web.fetch approval expired"])
        XCTAssertEqual(message.text, "full diagnostic text")
    }

    func testCalendarEventCardCarriesOnlyStructuredDetails() {
        let card = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("calendar-event"), "id": .string("event-1"),
                "start": .string("2026-08-24T14:00:00-07:00"),
                "time": .string("2:00 PM–3:00 PM"), "title": .string("Design review"),
                "location": .string("Studio"), "attendees": .array([.string("Ana")]),
                "calendars": .array([.string("Work")]),
                "calendarLink": .object(["url": .string("https://calendar.google.com/event?eid=event-1")]),
                "meetingLink": .object(["url": .string("https://zoom.us/j/12345")]),
            ])
        )
        guard case let .event(id, start, time, title, location, attendees, calendars, calendarLink, meetingLink)? = MessageResponseCard(part: card) else {
            return XCTFail("Expected a structured event card")
        }
        XCTAssertEqual(id, "event-1")
        XCTAssertEqual(start, "2026-08-24T14:00:00-07:00")
        XCTAssertEqual(time, CalendarEventPresentation.timeLabel(
            start: "2026-08-24T14:00:00-07:00", end: nil, fallback: ""))
        XCTAssertEqual(title, "Design review")
        XCTAssertEqual(location, "Studio")
        XCTAssertEqual(attendees, ["Ana"])
        XCTAssertEqual(calendars, ["Work"])
        XCTAssertEqual(calendarLink, "https://calendar.google.com/event?eid=event-1")
        XCTAssertEqual(meetingLink, "https://zoom.us/j/12345")
    }

    func testCalendarCardsDeriveLocalTimesAndKeepAllDayDates() throws {
        let zone = try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles"))
        let locale = Locale(identifier: "en_US")
        let label = CalendarEventPresentation.timeLabel(start: "2026-09-19T22:45:00.000Z",
            end: "2026-09-19T23:45:00Z", fallback: "10:45 PM–11:45 PM", timeZone: zone, locale: locale)
        XCTAssertTrue(label.contains("3:45"))
        XCTAssertTrue(label.contains("4:45"))
        XCTAssertFalse(label.contains("10:45"))
        XCTAssertEqual(CalendarEventPresentation.timeLabel(start: "2026-09-19", end: "2026-09-20",
            fallback: "midnight", timeZone: zone, locale: locale), "All day")
        let allDay = CalendarEventPresentation.dateCaption("2026-09-19", timeZone: zone, locale: locale)
        XCTAssertTrue(try XCTUnwrap(allDay).contains("19"))
        let overnight = CalendarEventPresentation.dateCaption("2026-09-19T01:00:00.000Z", timeZone: zone, locale: locale)
        XCTAssertTrue(try XCTUnwrap(overnight).contains("18"))
        XCTAssertEqual(CalendarEventPresentation.timeLabel(start: "invalid", end: nil, fallback: "TBD"), "TBD")
        let declaredAllDay = MessagePart(type: "data-card", data: .object([
            "kind": .string("calendar-event"), "title": .string("School holiday"),
            "start": .string("2026-09-19T00:00:00.000Z"), "allDay": .bool(true),
            "time": .string("All day")
        ]))
        guard case let .event(_, start, time, _, _, _, _, _, _)? = MessageResponseCard(part: declaredAllDay) else {
            return XCTFail("Expected all-day calendar card")
        }
        XCTAssertEqual(start, "2026-09-19")
        XCTAssertEqual(time, "All day")
    }

    func testProactiveAlertCardDecodesGroundedDetails() {
        let part = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("proactive-alert"),
                "id": .string("event-lead-1"),
                "category": .string("event"),
                "urgencyLabel": .string("Starts in 30 min"),
                "title": .string("Annual Physical"),
                "startsAt": .string("2026-09-02T16:00:00.000Z"),
                "details": .array([
                    .object(["label": .string("Location"), "value": .string("One Medical")]),
                ]),
            ])
        )
        guard case let .proactiveAlert(id, category, urgency, title, summary, startsAt, dueAt, details)? = MessageResponseCard(part: part) else {
            return XCTFail("Expected a proactive alert card")
        }
        XCTAssertEqual(id, "event-lead-1")
        XCTAssertEqual(category, "event")
        XCTAssertEqual(urgency, "Starts in 30 min")
        XCTAssertEqual(title, "Annual Physical")
        XCTAssertEqual(summary, "")
        XCTAssertEqual(startsAt, "2026-09-02T16:00:00.000Z")
        XCTAssertEqual(dueAt, "")
        XCTAssertEqual(details.first?.value, "One Medical")
    }

    func testLegacyTextCardsReformatSuppliedCalendarExamplesConservatively() {
        let agendaText = "Tomorrow has five upcoming events: 1) U13B Azul soccer practice from 6:30-8:00 PM at Crocker Amazon fields (outside usual hours). 2) Coffee with Tine at 9:00 AM at Home Coffee Roasters on Clement. 3) Technical interviews with Clay from 1:00-2:00 PM. 4) Kung Fu class at 4:45 PM at Tat Wong Academy on Geary. 5) Freyja's swim lesson at 5:15 PM at La Petite Baleen on Mason."
        guard case let .agenda(title, subtitle, items)? = MessageResponseCard.inferredLegacy(from: agendaText).first else {
            return XCTFail("Expected the numbered calendar paragraph to become an agenda")
        }
        XCTAssertEqual(title, "Tomorrow")
        XCTAssertEqual(subtitle, "5 upcoming events")
        XCTAssertEqual(items.count, 5)
        XCTAssertEqual(items[0].time, "6:30-8:00 PM")
        XCTAssertEqual(items[0].detail, "Crocker Amazon fields (outside usual hours)")
        XCTAssertEqual(items[2].title, "Technical interviews with Clay")

        let alertText = "\"Annual Physical\" starts in 30 minutes at One Medical, 559 Clay St. it is at One Medical, 559 Clay St; family@example.com called it."
        guard case let .proactiveAlert(_, category, urgency, title, summary, _, _, details)? = MessageResponseCard.inferredLegacy(from: alertText).first else {
            return XCTFail("Expected the historical event notice to become an alert")
        }
        XCTAssertEqual(category, "event")
        XCTAssertEqual(urgency, "Starts in 30 min")
        XCTAssertEqual(title, "Annual Physical")
        XCTAssertEqual(summary, "")
        XCTAssertEqual(details.first?.value, "One Medical, 559 Clay St")

        XCTAssertTrue(
            MessageResponseCard.inferredLegacy(
                from: "Try these: 1) Bring water. 2) Leave a little early."
            ).isEmpty
        )
    }

    func testOtherStructuredCardsDecodeCompleteToolBackedData() {
        let reminder = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("reminder"), "id": .string("reminder-1"),
                "title": .string("**Review** launch plan"), "schedule": .string("0 9 * * 1"),
                "nextFires": .string("2026-08-31T16:00:00.000Z"), "enabled": .bool(true),
            ])
        )
        guard case let .reminder(id, title, schedule, _, enabled)? = MessageResponseCard(part: reminder) else {
            return XCTFail("Expected a reminder card")
        }
        XCTAssertEqual(id, "reminder-1")
        XCTAssertEqual(title, "**Review** launch plan")
        XCTAssertEqual(schedule, "0 9 * * 1")
        XCTAssertTrue(enabled)

        let emails = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("email-results"), "id": .string("email-1"),
                "query": .string("launch"), "mailbox": .string("owner@example.com"),
                "complete": .bool(false), "matchingMessagesEstimate": .number(3),
                "messages": .array([
                    .object([
                        "id": .string("message-1"), "sender": .string("Ada"),
                        "subject": .string("**Launch** update"), "date": .string("today"),
                        "snippet": .string("Everything is ready."),
                    ]),
                ]),
            ])
        )
        guard case let .emails(_, _, query, mailbox, complete, estimate, messages)? = MessageResponseCard(part: emails) else {
            return XCTFail("Expected an email results card")
        }
        XCTAssertEqual(query, "launch")
        XCTAssertEqual(mailbox, "owner@example.com")
        XCTAssertFalse(complete)
        XCTAssertEqual(estimate, 3)
        XCTAssertEqual(messages.first?.subject, "**Launch** update")

        let documents = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("document-results"), "query": .string("launch"),
                "passages": .array([
                    .object([
                        "id": .string("passage-1"), "document": .string("Launch brief"),
                        "source": .string("upload"), "snippet": .string("**Ready** to ship."),
                        "similarity": .number(0.98),
                    ]),
                ]),
            ])
        )
        guard case let .documents(_, _, _, passages)? = MessageResponseCard(part: documents) else {
            return XCTFail("Expected a document results card")
        }
        XCTAssertEqual(passages.first?.document, "Launch brief")
        XCTAssertEqual(passages.first?.similarity, 0.98)

        let drive = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("drive-results"),
                "files": .array([
                    .object([
                        "id": .string("file-1"), "name": .string("Launch deck"),
                        "mimeType": .string("application/pdf"), "size": .string("2048"),
                        "url": .string("https://drive.example.com/launch"),
                    ]),
                ]),
            ])
        )
        guard case let .drive(_, _, _, files)? = MessageResponseCard(part: drive) else {
            return XCTFail("Expected a Drive results card")
        }
        XCTAssertEqual(files.first?.name, "Launch deck")
        XCTAssertEqual(files.first?.url, "https://drive.example.com/launch")

        let resource = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("resource"), "id": .string("doc-1"),
                "resourceType": .string("document"), "title": .string("**Launch** recap"),
                "subtitle": .string("Google Doc created"),
                "details": .array([.object(["label": .string("Shared with"), "value": .string("owner@example.com")])]),
                "link": .object(["label": .string("Open document"), "url": .string("https://docs.example.com/recap")]),
            ])
        )
        guard case let .resource(_, resourceType, title, _, details, linkLabel, linkURL)? = MessageResponseCard(part: resource) else {
            return XCTFail("Expected a resource card")
        }
        XCTAssertEqual(resourceType, "document")
        XCTAssertEqual(title, "**Launch** recap")
        XCTAssertEqual(details.first?.value, "owner@example.com")
        XCTAssertEqual(linkLabel, "Open document")
        XCTAssertEqual(linkURL, "https://docs.example.com/recap")

        let status = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("status"), "title": .string("Email draft ready"),
                "detail": .string("**Launch** recap"), "symbol": .string("envelope.badge.fill"),
                "details": .array([.object(["label": .string("To"), "value": .string("ada@example.com")])]),
            ])
        )
        guard case let .status(_, statusTitle, detail, symbol, statusDetails, statusLinkLabel, statusLinkURL)? = MessageResponseCard(part: status) else {
            return XCTFail("Expected a status card")
        }
        XCTAssertEqual(statusTitle, "Email draft ready")
        XCTAssertEqual(detail, "**Launch** recap")
        XCTAssertEqual(symbol, "envelope.badge.fill")
        XCTAssertEqual(statusDetails.first?.value, "ada@example.com")
        XCTAssertNil(statusLinkLabel)
        XCTAssertNil(statusLinkURL)
    }

    func testWorkspaceSettingsDecodesManagedReminders() throws {
        let data = Data(
            #"{"agent":{"name":"Assistant","timezone":"America/Los_Angeles","locale":"en-US","signature":""},"schedules":[],"reminders":[{"id":"reminder-1","text":"Get sunglasses from the car","kind":"once","status":"scheduled","nextRunAt":"2026-09-02T20:00:00.000Z"},{"id":"reminder-2","text":"Take vitamins","kind":"recurring","status":"delivering","nextRunAt":null}],"policies":[],"goalAutomationCount":0}"#.utf8
        )

        let settings = try JSONDecoder().decode(WorkspaceSettings.self, from: data)
        XCTAssertEqual(settings.reminders.map(\.text), ["Get sunglasses from the car", "Take vitamins"])
        XCTAssertFalse(settings.reminders[0].repeats)
        XCTAssertTrue(settings.reminders[1].repeats)
        XCTAssertTrue(settings.reminders[1].isDelivering)

        let legacy = Data(
            #"{"agent":{"name":"Assistant","timezone":"UTC","locale":"en-US","signature":""},"schedules":[],"policies":[],"goalAutomationCount":0}"#.utf8
        )
        XCTAssertEqual(
            try JSONDecoder().decode(WorkspaceSettings.self, from: legacy).reminders.count,
            0
        )
    }

    func testResponseCardsDecodeWebSearchResultsAndAvailability() {
        let search = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("web-search-results"), "id": .string("search-1"),
                "query": .string("best time to visit Lisbon"),
                "results": .array([
                    .object([
                        "id": .string("result-1"), "title": .string("Lisbon travel guide"),
                        "url": .string("https://example.com/lisbon"),
                        "snippet": .string("Late spring is ideal."),
                    ]),
                    .object([
                        "id": .string("result-2"), "title": .string("Dropped without a URL"),
                        "url": .string(""), "snippet": .string("No link."),
                    ]),
                ]),
            ])
        )
        guard case let .search(_, _, query, results)? = MessageResponseCard(part: search) else {
            return XCTFail("Expected a web search results card")
        }
        XCTAssertEqual(query, "best time to visit Lisbon")
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results.first?.title, "Lisbon travel guide")
        XCTAssertEqual(results.first?.url, "https://example.com/lisbon")
        XCTAssertEqual(results.first?.snippet, "Late spring is ideal.")

        let availability = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("availability"), "id": .string("availability-1"),
                "timeMin": .string("2026-08-24T09:00:00-07:00"),
                "timeMax": .string("2026-08-24T17:00:00-07:00"),
                "busy": .array([
                    .object([
                        "start": .string("2026-08-24T10:00:00-07:00"),
                        "end": .string("2026-08-24T11:30:00-07:00"),
                        "calendar": .string("Work"),
                    ]),
                    .object(["start": .string(""), "end": .string(""), "calendar": .string("Dropped")]),
                ]),
                "calendarsChecked": .array([.string("Work"), .string("Family")]),
                "complete": .bool(false),
                "note": .string("Some calendars did not return free/busy data."),
            ])
        )
        guard case let .availability(_, timeMin, timeMax, busy, calendarsChecked, complete, note)? =
                MessageResponseCard(part: availability) else {
            return XCTFail("Expected an availability card")
        }
        XCTAssertEqual(timeMin, "2026-08-24T09:00:00-07:00")
        XCTAssertEqual(timeMax, "2026-08-24T17:00:00-07:00")
        XCTAssertEqual(busy.count, 1)
        XCTAssertEqual(busy.first?.calendar, "Work")
        XCTAssertEqual(calendarsChecked, ["Work", "Family"])
        XCTAssertFalse(complete)
        XCTAssertEqual(note, "Some calendars did not return free/busy data.")
    }

    func testResponseCardsDecodeEmailThreadAndSheetRows() {
        let thread = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("email-thread"), "id": .string("thread-1"),
                "subject": .string("Launch recap"), "messageCount": .number(4),
                "messages": .array([
                    .object([
                        "id": .string("m1"), "sender": .string("Ada <ada@example.com>"),
                        "date": .string("Mon, 24 Aug 2026 09:00:00 -0700"),
                        "excerpt": .string("The plan is ready."),
                    ]),
                ]),
            ])
        )
        guard case let .thread(_, subject, messageCount, messages)? = MessageResponseCard(part: thread) else {
            return XCTFail("Expected an email thread card")
        }
        XCTAssertEqual(subject, "Launch recap")
        XCTAssertEqual(messageCount, 4)
        XCTAssertEqual(messages.first?.sender, "Ada <ada@example.com>")
        XCTAssertEqual(messages.first?.excerpt, "The plan is ready.")

        let sheet = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("sheet-rows"), "id": .string("sheet-1"),
                "sheetName": .string("Budget"), "totalRows": .number(42),
                "rows": .array([
                    .array([.string("Item"), .string("Cost")]),
                    .array([.string("Flights"), .number(640)]),
                ]),
                "link": .object(["label": .string("Open spreadsheet"), "url": .string("https://sheets.example.com/budget")]),
            ])
        )
        guard case let .sheetRows(_, sheetName, rows, totalRows, linkURL)? = MessageResponseCard(part: sheet) else {
            return XCTFail("Expected a sheet rows card")
        }
        XCTAssertEqual(sheetName, "Budget")
        XCTAssertEqual(totalRows, 42)
        XCTAssertEqual(rows, [["Item", "Cost"], ["Flights", "640"]])
        XCTAssertEqual(linkURL, "https://sheets.example.com/budget")
    }

    func testStatusCardCarriesItsOpenLinkWhenPresent() {
        let updated = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("status"), "id": .string("sheet-written-1"),
                "title": .string("Sheet updated"),
                "detail": .string("3 rows added to Budget."),
                "symbol": .string("tablecells.fill"),
                "link": .object(["label": .string("Open spreadsheet"), "url": .string("https://sheets.example.com/budget")]),
            ])
        )
        guard case let .status(_, _, _, _, _, linkLabel, linkURL)? = MessageResponseCard(part: updated) else {
            return XCTFail("Expected a status card")
        }
        XCTAssertEqual(linkLabel, "Open spreadsheet")
        XCTAssertEqual(linkURL, "https://sheets.example.com/budget")
    }

    func testGeneratedCardGroundedOnTheAnswerHeadsTheReplyInsteadOfReplacingIt() {
        func card(grounding: String?) -> MessageResponseCard {
            var data: [String: JSONValue] = [
                "kind": .string("generated-card"),
                "id": .string("card-1"),
                "spec": .object([
                    "version": .number(1),
                    "title": .string("Drive to Bernal Intermediate"),
                    "accessibilityLabel": .string("Drive time to Bernal Intermediate"),
                    "sourceLabel": .string("This answer"),
                    "facts": .array([
                        .object([
                            "id": .string("eta"),
                            "label": .string("Drive time"),
                            "value": .string("1 hour 15 minutes to 1 hour 30 minutes"),
                            "source": .string("This answer"),
                        ]),
                    ]),
                    "blocks": .array([.object(["type": .string("facts"), "factIds": .array([.string("eta")])])]),
                ]),
            ]
            if let grounding { data["grounding"] = .string(grounding) }
            let part = MessagePart(type: "data-card", data: .object(data))
            guard let card = MessageResponseCard(part: part) else {
                XCTFail("Expected the payload to decode as a generated card")
                return .duration(title: "", duration: "", detail: nil, confidence: nil)
            }
            return card
        }

        let fromAnswer = card(grounding: "answer")
        XCTAssertTrue(fromAnswer.summarizesAnswer)
        // The reply also carried the route and the latest departure time, and
        // one redrawn value must not delete them.
        XCTAssertFalse(MessageResponseCard.replacesProse([fromAnswer]))

        let fromLookup = card(grounding: "evidence")
        XCTAssertFalse(fromLookup.summarizesAnswer)
        XCTAssertTrue(MessageResponseCard.replacesProse([fromLookup]))

        // A build that sends no grounding is a lookup card, the older contract.
        XCTAssertFalse(card(grounding: nil).summarizesAnswer)
        XCTAssertFalse(MessageResponseCard.replacesProse([]))
    }

    func testUnknownOrMalformedNativeCompositionPreservesCompleteReplyText() {
        func card(blocks: [JSONValue]) -> MessageResponseCard {
            let part = MessagePart(type: "data-card", data: .object([
                "kind": .string("generated-card"),
                "id": .string("card-compat"),
                "grounding": .string("evidence"),
                "spec": .object([
                    "version": .number(1),
                    "title": .string("Trip overview"),
                    "sourceLabel": .string("Calendar and booking"),
                    "facts": .array([
                        .object(["id": .string("place"), "label": .string("Venue"), "value": .string("Bernal Intermediate")]),
                    ]),
                    "blocks": .array(blocks),
                ]),
            ]))
            guard let card = MessageResponseCard(part: part) else {
                XCTFail("Expected the generated card to remain available as a safe partial view")
                return .duration(title: "", duration: "", detail: nil, confidence: nil)
            }
            return card
        }

        let unknown = card(blocks: [
            .object(["type": .string("future_component"), "secret": .string("not rendered")]),
        ])
        XCTAssertFalse(MessageResponseCard.replacesProse([unknown]))

        let unresolvedReference = card(blocks: [
            .object(["type": .string("facts"), "factIds": .array([.string("missing")])]),
        ])
        XCTAssertFalse(MessageResponseCard.replacesProse([unresolvedReference]))

        let mixedSection = card(blocks: [
            .object([
                "type": .string("section"),
                "title": .string("Today"),
                "blocks": .array([
                    .object(["type": .string("facts"), "factIds": .array([.string("place")])]),
                    .object(["type": .string("future_component")]),
                ]),
            ]),
        ])
        XCTAssertFalse(MessageResponseCard.replacesProse([mixedSection]))
    }

    func testRuntimeCorrectionDoesNotAnswerAnUnrelatedLatestQuestion() {
        var message = ChatMessage.optimistic(role: .assistant, text: "Corrections to earlier replies")
        XCTAssertTrue(message.isConversationAnswer)
        message.parts.append(MessagePart(type: "notice", notice: "audit-correction"))
        XCTAssertFalse(message.isConversationAnswer)
    }

    func testProviderFailureNoticeIsRecognized() {
        var message = ChatMessage.optimistic(role: .assistant, text: "Provider failed")
        message.parts.append(MessagePart(type: "notice", notice: "provider-failed"))
        XCTAssertEqual(message.noticeKind, .providerFailed)
        XCTAssertFalse(message.isConversationAnswer)
    }

    func testWeatherUnitsCollapsePairsAndConvertToThePreferredUnit() {
        XCTAssertEqual(WeatherUnits.localized("17°C (63°F)", preferFahrenheit: true), "63°F")
        XCTAssertEqual(WeatherUnits.localized("17°C (63°F)", preferFahrenheit: false), "17°C")
        XCTAssertEqual(WeatherUnits.localized("63°F (17°C)", preferFahrenheit: false), "17°C")
        XCTAssertEqual(WeatherUnits.localized("17–20°C (63–68°F)", preferFahrenheit: true), "63–68°F")
        XCTAssertEqual(WeatherUnits.localized("18°C", preferFahrenheit: true), "64°F")
        XCTAssertEqual(WeatherUnits.localized("98°F", preferFahrenheit: false), "37°C")
        XCTAssertEqual(WeatherUnits.localized("17–19°C", preferFahrenheit: true), "63–66°F")
        XCTAssertEqual(WeatherUnits.localized("17ºC", preferFahrenheit: false), "17°C")
        XCTAssertEqual(
            WeatherUnits.localized("overcast, wind 18 km/h", preferFahrenheit: true),
            "overcast, wind 18 km/h"
        )
    }

    func testWeatherCaptionNamesTheDayOnPerDayForecastCards() {
        let dayCard = [
            MessageResponseCard.WeatherDetail(label: "Day", value: "Saturday"),
            MessageResponseCard.WeatherDetail(label: "Forecast", value: "Sunny, 16–23°C"),
        ]
        XCTAssertEqual(WeatherPresentation.caption(details: dayCard, hasForecast: false), "Saturday")
        XCTAssertEqual(WeatherPresentation.caption(details: [], hasForecast: false), "Today")
        XCTAssertEqual(WeatherPresentation.caption(details: [], hasForecast: true), "Forecast")
        let updated = [MessageResponseCard.WeatherDetail(label: "Updated", value: "3:48 PM PDT")]
        XCTAssertEqual(WeatherPresentation.caption(details: updated, hasForecast: false), "Today · 3:48 PM PDT")
    }

    func testWeatherFactsSplitIntoCurrentAndPerDayForecast() {
        let details = [
            MessageResponseCard.WeatherDetail(label: "Today", value: "17–20°C"),
            MessageResponseCard.WeatherDetail(label: "Wind", value: "10 km/h"),
            MessageResponseCard.WeatherDetail(label: "Saturday morning", value: "Sunny, 17°C"),
            MessageResponseCard.WeatherDetail(label: "Saturday afternoon", value: "Clear, 22°C"),
            MessageResponseCard.WeatherDetail(label: "Sun", value: "Rain, 16°C"),
        ]
        let (current, days) = WeatherPresentation.split(details)
        XCTAssertEqual(current.map(\.label), ["Today", "Wind"])
        XCTAssertEqual(days.map(\.day), ["Saturday", "Sun"])
        XCTAssertEqual(days[0].facts.map(\.label), ["Morning", "Afternoon"])
        XCTAssertEqual(days[1].facts.map(\.label), ["Forecast"])
        XCTAssertEqual(days[1].facts.map(\.value), ["Rain, 16°C"])
    }

    func testIdentifierFormattingDoesNotExposeImplementationPunctuation() {
        XCTAssertEqual("web.fetch".sentenceCaseIdentifier, "Web Fetch")
        XCTAssertEqual("adhoc".sentenceCaseIdentifier, "Ad hoc")
        XCTAssertEqual("waiting_approval".sentenceCaseIdentifier, "Waiting for approval")
    }

    func testDecodesActivityParityFlags() throws {
        let data = #"{"id":"1","type":"scheduled","status":"running","title":"Refresh","progress":"Working","trust":"owner","spentUsd":"0","budgetUsdLimit":"1","updatedAt":"2026-01-01T00:00:00Z","archivedAt":null,"hasPendingApproval":false,"hasActiveAutonomy":true,"stuckWaiting":true}"#.data(using: .utf8)!
        let item = try JSONDecoder().decode(ActivityItem.self, from: data)

        XCTAssertEqual(item.hasActiveAutonomy, true)
        XCTAssertEqual(item.stuckWaiting, true)
    }

    func testResolvedApprovalsDecodeWithoutPayloads() throws {
        // The resolved history deliberately drops payload/resolutionPayload —
        // they stay in the database. Decoding the row as the pending list's
        // full record failed the whole overview the moment a single approval
        // resolved, taking Activity, Goals, and Documents down with it.
        let trimmed = """
        {"pending":[],"resolved":[
          {"approval":{"id":"a1","taskId":"t1","shortCode":"A7","summary":"Search the web",
                       "status":"approved","requestedAt":"2026-08-27T09:00:00.000Z",
                       "resolvedAt":"2026-08-27T09:05:00.000Z","resolvedVia":"web",
                       "expiresAt":"2026-08-28T09:00:00.000Z","edited":true},
           "taskType":"chat"}
        ]}
        """.data(using: .utf8)!
        let inbox = try JSONDecoder().decode(ApprovalInbox.self, from: trimmed)
        XCTAssertEqual(inbox.resolved.first?.approval.id, "a1")
        XCTAssertEqual(inbox.resolved.first?.approval.edited, true)

        // A server build from before the trim still sends the full row; it
        // must still decode.
        let legacy = """
        {"pending":[],"resolved":[
          {"approval":{"id":"a1","taskId":"t1","shortCode":"A7","summary":"Search the web",
                       "payload":{"query":"cafes"},"resolutionPayload":{"approved":true},
                       "status":"approved","requestedAt":"2026-08-27T09:00:00.000Z",
                       "resolvedAt":"2026-08-27T09:05:00.000Z","resolvedVia":"web",
                       "expiresAt":"2026-08-28T09:00:00.000Z"},
           "taskType":"chat"}
        ]}
        """.data(using: .utf8)!
        let legacyInbox = try JSONDecoder().decode(ApprovalInbox.self, from: legacy)
        XCTAssertEqual(legacyInbox.resolved.first?.approval.id, "a1")
        XCTAssertNil(legacyInbox.resolved.first?.approval.edited)
    }

    func testCapabilityStatusDistinguishesUnavailableFromMissingSetup() throws {
        let unavailableData = #"{"id":"google","title":"Google Workspace","summary":"Workspace tools","enabled":true,"ready":false,"status":"unavailable","detail":"agent readiness unavailable"}"#.data(using: .utf8)!
        let unavailable = try JSONDecoder().decode(WorkspaceCapability.self, from: unavailableData)
        XCTAssertEqual(unavailable.statusTitle, "Status unavailable")

        let legacyData = #"{"id":"google","title":"Google Workspace","summary":"Workspace tools","enabled":true,"ready":false,"detail":"missing Google OAuth credentials"}"#.data(using: .utf8)!
        let legacy = try JSONDecoder().decode(WorkspaceCapability.self, from: legacyData)
        XCTAssertEqual(legacy.statusTitle, "Setup needed")
    }

    func testActivityTitlesKeepHumanLanguageAndFormatMachineIdentifiers() {
        let generatedTitle = activityItem(title: "document-processing")
        let humanTitle = activityItem(title: "Review the travel plan")
        let missingTitle = activityItem(title: nil, type: "ambient-refresh")

        XCTAssertEqual(generatedTitle.displayTitle, "Document Processing")
        XCTAssertEqual(humanTitle.displayTitle, "Review the travel plan")
        XCTAssertEqual(missingTitle.displayTitle, "Ambient Refresh")
    }

    func testGoalTitlesHideAutomationRunIdentifiers() {
        let generated = goalRecord(title: "gate-test-1787275766328-0.08720229193630735")
        let human = goalRecord(title: "Find a senior product role")
        let machine = goalRecord(title: "quarterly-review")

        XCTAssertEqual(generated.displayTitle, "Gate Test")
        XCTAssertEqual(human.displayTitle, "Find a senior product role")
        XCTAssertEqual(machine.displayTitle, "Quarterly Review")
    }

    func testActivityProgressRemovesKnownTechnicalPrefixesWithoutRewritingDetails() {
        let documentTask = activityItem(
            title: "document-processing",
            progress: "documents.process skipped because the documents module is disabled"
        )
        let ambientTask = activityItem(
            title: "ambient-refresh",
            progress: "ambient: no fresh location — snapshot cleared"
        )
        let humanTask = activityItem(title: "Travel plan", progress: "Three options are ready to compare")

        XCTAssertEqual(
            documentTask.displayProgress,
            "Document processing skipped because the documents module is disabled"
        )
        XCTAssertEqual(ambientTask.displayProgress, "Background update: no fresh location — snapshot cleared")
        XCTAssertEqual(humanTask.displayProgress, "Three options are ready to compare")
    }

    func testActivityBudgetSummaryUsesGlanceableCurrencyPrecision() {
        let task = activityItem(
            title: "Background refresh",
            spentUsd: "0.000083",
            budgetUsdLimit: "0.1000"
        )

        XCTAssertEqual(task.budgetSummary, "$0.00008 of $0.10")
    }

    func testLiveActivityContentKeepsPromptPrivateAndExpiresQuickly() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let content = LiveActivityManager.content(
            thought: .thinking,
            detail: "Private calendar and travel details",
            pendingCount: 0,
            now: now
        )

        XCTAssertEqual(content.state.detail, "Preparing a response")
        XCTAssertEqual(content.staleDate, now.addingTimeInterval(60))
        XCTAssertEqual(content.relevanceScore, 0.65)
    }

    /// The race behind "the Island stays after I approve": a present suspended
    /// mid-way while the dismiss for the decision ran to completion, then
    /// finished and put the Island back.
    @MainActor
    func testQueuedDismissIsTheLastWordOverAnEarlierPresent() async {
        var visible = false
        var order: [String] = []
        let queue = LatestWinsQueue()
        async let present: Void = queue.run(supersedable: true) {
            try? await Task.sleep(for: .milliseconds(60))
            visible = true
            order.append("present")
        }
        try? await Task.sleep(for: .milliseconds(10))
        async let dismiss: Void = queue.run(supersedable: false) {
            visible = false
            order.append("dismiss")
        }
        _ = await (present, dismiss)
        XCTAssertFalse(visible)
        XCTAssertEqual(order.last, "dismiss")
    }

    @MainActor
    func testQueueRunsOneAtATimeAndKeepsOnlyTheNewestWaitingState() async {
        var order: [String] = []
        let queue = LatestWinsQueue()
        async let busy: Void = queue.run(supersedable: false) {
            order.append("busy-start")
            try? await Task.sleep(for: .milliseconds(60))
            order.append("busy-end")
        }
        try? await Task.sleep(for: .milliseconds(10))
        async let first: Void = queue.run(supersedable: true) { order.append("first") }
        async let second: Void = queue.run(supersedable: true) { order.append("second") }
        _ = await (busy, first, second)
        XCTAssertEqual(order, ["busy-start", "busy-end", "second"])
    }

    /// Every refresh path reconciles the Island, and each push used to carry a
    /// fresh timestamp, so an unchanged approval still cost an ActivityKit
    /// update. What the owner can see is what decides whether to push.
    func testLiveActivityPushesOnlyWhatTheOwnerCanSeeChange() {
        let early = LiveActivityManager.content(
            thought: .needsYou, detail: "Send the note", pendingCount: 2, now: Date(timeIntervalSince1970: 0))
        let later = LiveActivityManager.content(
            thought: .needsYou, detail: "Send a different note", pendingCount: 2, now: Date(timeIntervalSince1970: 90))
        XCTAssertNotEqual(early.state, later.state, "The timestamp always differs")
        XCTAssertEqual(LiveActivityManager.shown(for: early), LiveActivityManager.shown(for: later))

        let fewer = LiveActivityManager.content(
            thought: .needsYou, detail: "Send the note", pendingCount: 1, now: Date(timeIntervalSince1970: 90))
        XCTAssertNotEqual(LiveActivityManager.shown(for: early), LiveActivityManager.shown(for: fewer))
    }

    func testOnlyOwnerDecisionsAreEligibleForTheSystemIsland() {
        XCTAssertFalse(LiveActivityManager.shouldPresentSystemActivity(for: .thinking, pendingCount: 0))
        XCTAssertFalse(LiveActivityManager.shouldPresentSystemActivity(for: .backgroundWork, pendingCount: 0))
        XCTAssertFalse(LiveActivityManager.shouldPresentSystemActivity(for: .finished, pendingCount: 0))
        XCTAssertFalse(LiveActivityManager.shouldPresentSystemActivity(for: .needsYou, pendingCount: 0))
        XCTAssertTrue(LiveActivityManager.shouldPresentSystemActivity(for: .needsYou, pendingCount: 1))
    }

    func testAttentionActivityIsGlanceableAndPrioritized() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let content = LiveActivityManager.content(
            thought: .needsYou,
            detail: "Approve access to a private account",
            pendingCount: 2,
            now: now
        )

        XCTAssertEqual(content.state.detail, "A decision is ready to review")
        XCTAssertEqual(content.state.pendingCount, 2)
        XCTAssertNil(content.staleDate)
        XCTAssertEqual(content.relevanceScore, 1)
    }

    func testActivityCrownAttachesAcrossDynamicIslandSafeAreas() {
        XCTAssertEqual(
            ActivityCrown.islandTopInset(safeAreaTopInset: 59),
            10,
            accuracy: 0.001
        )
        XCTAssertEqual(
            ActivityCrown.islandTopInset(safeAreaTopInset: 62),
            13,
            accuracy: 0.001
        )
        XCTAssertEqual(
            ActivityCrown.islandTopInset(safeAreaTopInset: 47),
            14,
            accuracy: 0.001
        )
    }

    func testTopOverlaysClearTheIslandWhetherOrNotTheCrownIsShowing() {
        // iPhone 15 Pro. Idle the crown draws nothing, but its collapsed frame
        // still stands for the hardware pill it is attached to — 10 to 47, a
        // point high by design — so an overlay starts below that. This used to
        // be a flat 4pt, which put the error banner behind the pill.
        XCTAssertEqual(
            ActivityCrown.overlayTopInset(
                isAccessibilitySize: false,
                isExpanded: false,
                safeAreaTopInset: 59
            ),
            55,
            accuracy: 0.001
        )
        // Expanded, the crown itself is what has to be cleared. Measured from
        // the physical top edge: the previous safe-area-relative number was 35,
        // which landed inside the crown rather than below it.
        XCTAssertEqual(
            ActivityCrown.overlayTopInset(
                isAccessibilitySize: false,
                isExpanded: true,
                safeAreaTopInset: 59
            ),
            94,
            accuracy: 0.001
        )
        XCTAssertEqual(
            ActivityCrown.overlayTopInset(
                isAccessibilitySize: true,
                isExpanded: true,
                safeAreaTopInset: 59
            ),
            206,
            accuracy: 0.001
        )
        // The flush notch has no floating pill, and its own collapsed geometry
        // still resolves to a seat below the cutout.
        XCTAssertEqual(
            ActivityCrown.overlayTopInset(
                isAccessibilitySize: false,
                isExpanded: false,
                safeAreaTopInset: 47
            ),
            59,
            accuracy: 0.001
        )
    }

    func testTopOverlayNeverStartsInsideTheIslandOnAnyReportedInset() {
        for step in 20...70 {
            let inset = CGFloat(step)
            let islandBottom = ActivityCrown.islandTopInset(safeAreaTopInset: inset)
                + ActivityCrown.collapsedHeight
            for isExpanded in [false, true] {
                for isAccessibilitySize in [false, true] {
                    XCTAssertGreaterThanOrEqual(
                        ActivityCrown.overlayTopInset(
                            isAccessibilitySize: isAccessibilitySize,
                            isExpanded: isExpanded,
                            safeAreaTopInset: inset
                        ),
                        islandBottom + ActivityCrown.overlayClearanceGap,
                        "overlay drew into the island at a \(inset)pt top inset"
                    )
                }
            }
        }
    }

    func testActivityDetailIsSafeForBothSystemAndInAppStatusSurfaces() {
        XCTAssertEqual(
            LiveActivityManager.safeDetail(
                for: .thinking,
                proposed: "Private calendar and travel details"
            ),
            "Preparing a response"
        )
        XCTAssertEqual(
            LiveActivityManager.safeDetail(for: .backgroundWork, proposed: "Anything private"),
            "Continuing in the background"
        )
        XCTAssertEqual(
            LiveActivityManager.safeDetail(for: .needsYou, proposed: "Approve a private account"),
            "A decision is ready to review"
        )
        // A turn the owner stopped should not tell them to open the app they
        // stopped it from, even though it shares the failed tone.
        XCTAssertEqual(
            LiveActivityManager.safeDetail(for: .stoppedByYou, proposed: "Anything private"),
            "You stopped this turn"
        )
        XCTAssertEqual(
            LiveActivityManager.safeDetail(for: .stopped, proposed: "Anything private"),
            "Open Assistant for details"
        )
    }

    func testToolProgressNeverPublishesATerminalTurnState() {
        // A single finished tool call is not a finished turn. Publishing its own
        // tone made the activity surfaces claim the whole turn was done — and
        // fire a success haptic — after every successful step.
        for status in ["succeeded", "failed", "denied", "awaiting_approval", "running"] {
            let activity = ToolActivity(toolName: "web.search", status: status, step: 2)
            XCTAssertEqual(
                activity.inProgressThought.tone,
                .working,
                "Tool status \(status) should read as progress, not an outcome"
            )
            XCTAssertEqual(activity.inProgressThought.label, activity.displayLabel)
        }

        // The per-step accessor keeps reporting the tool's own outcome.
        XCTAssertEqual(
            ToolActivity(toolName: "web.search", status: "succeeded", step: 2).thought.tone,
            .done
        )
    }

    func testPullMenuMotionCoversBoundaryReversalFlingAndAccessibilityCases() {
        // The regular menu is 236pt tall; its opening action must stay short
        // even though its two rows make the sheet visually substantial.
        let standardHeight: CGFloat = 236
        let accessibilityHeight: CGFloat = 360

        XCTAssertEqual(
            PullMenuMotion.openingCommitmentDistance(revealHeight: standardHeight),
            59,
            accuracy: 0.001
        )
        XCTAssertEqual(
            PullMenuMotion.openingCommitmentDistance(revealHeight: accessibilityHeight),
            60,
            accuracy: 0.001
        )
        XCTAssertEqual(PullMenuMotion.openingCommitmentDistance(revealHeight: 0), 0)
        XCTAssertEqual(PullMenuMotion.closingCommitmentDistance(revealHeight: standardHeight), 51.92, accuracy: 0.001)
        XCTAssertEqual(PullMenuMotion.closingCommitmentDistance(revealHeight: accessibilityHeight), 56, accuracy: 0.001)

        // Upward, downward, and over-extended drags all follow one clamped
        // path. That is what prevents a reversing slow pull from snap-back.
        XCTAssertEqual(
            PullMenuMotion.openingDistance(translationY: -34, revealHeight: standardHeight),
            34
        )
        XCTAssertEqual(
            PullMenuMotion.openingDistance(translationY: 18, revealHeight: standardHeight),
            0
        )
        XCTAssertEqual(
            PullMenuMotion.openingDistance(translationY: -900, revealHeight: standardHeight),
            standardHeight
        )
        XCTAssertEqual(
            PullMenuMotion.closingDistance(translationY: 34, revealHeight: standardHeight),
            34
        )
        XCTAssertEqual(
            PullMenuMotion.closingDistance(translationY: -18, revealHeight: standardHeight),
            0
        )
        XCTAssertEqual(
            PullMenuMotion.closingDistance(translationY: 900, revealHeight: standardHeight),
            standardHeight
        )

        // A quick flick can commit, but only in the direction of the menu;
        // a prediction pointing the other way cannot make a menu open/close.
        XCTAssertEqual(
            PullMenuMotion.projectedOpeningDistance(
                translationY: -18,
                predictedEndTranslationY: -75,
                revealHeight: standardHeight
            ),
            75
        )
        XCTAssertEqual(
            PullMenuMotion.projectedOpeningDistance(
                translationY: 18,
                predictedEndTranslationY: 60,
                revealHeight: standardHeight
            ),
            0
        )
        XCTAssertEqual(
            PullMenuMotion.projectedClosingDistance(
                translationY: 18,
                predictedEndTranslationY: 75,
                revealHeight: standardHeight
            ),
            75
        )
        XCTAssertEqual(
            PullMenuMotion.projectedClosingDistance(
                translationY: -18,
                predictedEndTranslationY: -60,
                revealHeight: standardHeight
            ),
            0
        )

        // UIKit's predicted end can be surprisingly large for a tiny probe.
        // Momentum is accepted only after enough physical travel, and a slow
        // release always lands where the finger actually stopped.
        XCTAssertEqual(
            PullMenuMotion.releaseDistance(
                actualDistance: 24,
                projectedDistance: 90,
                gestureDuration: 0.08
            ),
            24
        )
        XCTAssertEqual(
            PullMenuMotion.releaseDistance(
                actualDistance: 36,
                projectedDistance: 90,
                gestureDuration: 0.35
            ),
            36
        )
        XCTAssertEqual(
            PullMenuMotion.releaseDistance(
                actualDistance: 36,
                projectedDistance: 90,
                gestureDuration: 0.1
            ),
            90
        )

        // Both directions reject sideways and ambiguous diagonals. Opening
        // shares its grab region with the composer, while closing coexists
        // with the horizontally scrolling extra-large menu.
        XCTAssertTrue(PullMenuMotion.hasOpeningIntent(translationX: 8, translationY: -40))
        XCTAssertFalse(PullMenuMotion.hasOpeningIntent(translationX: 40, translationY: -8))
        XCTAssertFalse(PullMenuMotion.hasOpeningIntent(translationX: 20, translationY: -20))
        XCTAssertFalse(PullMenuMotion.hasOpeningIntent(translationX: 4, translationY: 40))
        XCTAssertTrue(PullMenuMotion.hasClosingIntent(translationX: 8, translationY: 40))
        XCTAssertFalse(PullMenuMotion.hasClosingIntent(translationX: 40, translationY: 8))
        XCTAssertFalse(PullMenuMotion.hasClosingIntent(translationX: 20, translationY: 20))
        XCTAssertFalse(PullMenuMotion.hasClosingIntent(translationX: 4, translationY: -40))

        // Early diagonal jitter remains undecided instead of permanently
        // stealing the gesture from the direction the finger settles into.
        XCTAssertFalse(PullMenuMotion.hasOpeningIntent(translationX: 12, translationY: -11))
        XCTAssertFalse(PullMenuMotion.hasHorizontalIntent(translationX: 12, translationY: -11))
        XCTAssertTrue(PullMenuMotion.hasOpeningIntent(translationX: 12, translationY: -30))
        XCTAssertFalse(PullMenuMotion.hasHorizontalIntent(translationX: 12, translationY: -30))

        // Tiny probes do not claim either axis, while deliberate horizontal
        // swipes keep cursor movement and accessibility strips undisturbed.
        XCTAssertFalse(PullMenuMotion.hasOpeningIntent(translationX: 3, translationY: -9))
        XCTAssertFalse(PullMenuMotion.hasClosingIntent(translationX: 3, translationY: 9))
        XCTAssertFalse(PullMenuMotion.hasHorizontalIntent(translationX: 11, translationY: 1))
        XCTAssertTrue(PullMenuMotion.hasHorizontalIntent(translationX: 18, translationY: 4))

        XCTAssertFalse(
            PullMenuMotion.holdsOpeningDetent(
                revealDistance: 58,
                revealHeight: standardHeight,
                detentHeld: false
            )
        )
        XCTAssertTrue(
            PullMenuMotion.holdsOpeningDetent(
                revealDistance: 59,
                revealHeight: standardHeight,
                detentHeld: false
            )
        )
        XCTAssertTrue(
            PullMenuMotion.holdsOpeningDetent(
                revealDistance: 48,
                revealHeight: standardHeight,
                detentHeld: true
            )
        )
        XCTAssertFalse(
            PullMenuMotion.holdsOpeningDetent(
                revealDistance: 47,
                revealHeight: standardHeight,
                detentHeld: true
            )
        )

        // Once an opened menu's close detent has fired at roughly 64pt, a
        // release stays closed. A shallow downward probe springs back open.
        XCTAssertFalse(
            PullMenuMotion.closesOnRelease(
                dragDistance: 63,
                revealHeight: standardHeight,
                detentHeld: true
            )
        )
        XCTAssertTrue(
            PullMenuMotion.closesOnRelease(
                dragDistance: 64,
                revealHeight: standardHeight,
                detentHeld: true
            )
        )
        XCTAssertFalse(
            PullMenuMotion.closesOnRelease(
                dragDistance: 39,
                revealHeight: standardHeight,
                detentHeld: false
            )
        )
        XCTAssertTrue(
            PullMenuMotion.closesOnRelease(
                dragDistance: 40,
                revealHeight: standardHeight,
                detentHeld: false
            )
        )
    }

    func testTranscriptFollowsIncomingGrowthUntilTheReaderScrollsAway() {
        var follow = TranscriptFollowState()
        // A tall incoming message can move the measured bottom before the
        // transcript has followed it. Layout and animation do not opt out.
        follow.observe(atBottom: false, phase: .idle)
        follow.observe(atBottom: false, phase: .animating)
        XCTAssertTrue(follow.followsLatest)
        XCTAssertTrue(follow.shouldPin(userIsDragging: false))
        XCTAssertFalse(follow.shouldPin(userIsDragging: true))

        follow.observe(atBottom: false, phase: .interacting)
        follow.observe(atBottom: false, phase: .decelerating)
        follow.observe(atBottom: false, phase: .idle)
        XCTAssertFalse(follow.followsLatest)
        XCTAssertFalse(follow.shouldPin(userIsDragging: false))

        // Further messages do not pull the reader out of an older answer.
        follow.observe(atBottom: false, phase: .idle)
        XCTAssertFalse(follow.followsLatest)
        follow.observe(atBottom: true, phase: .decelerating)
        XCTAssertTrue(follow.followsLatest)

        follow.observe(atBottom: false, phase: .interacting)
        follow.resume() // Sending or pressing Jump to latest resumes following.
        follow.observe(atBottom: false, phase: .animating)
        XCTAssertTrue(follow.followsLatest)
    }

    func testPullMenuPresentationKeepsClearanceAndRevealsRowsBottomUp() {
        XCTAssertEqual(
            PullMenuMotion.composerSurfaceBottomSpacing,
            12,
            accuracy: 0.001
        )
        XCTAssertEqual(
            PullMenuMotion.menuRevealHeight(
                contentHeight: 383,
                bottomSafeAreaInset: 34
            ),
            417,
            accuracy: 0.001
        )
        XCTAssertEqual(
            PullMenuMotion.conversationSurfaceOffset(revealDistance: 137),
            137,
            accuracy: 0.001
        )
        // Normal layouts pair the destinations into rows. The bottom row
        // appears first, and every destination in a row shares a fade rank.
        // Nine destinations leave the last row holding More on its own.
        XCTAssertEqual(
            (0..<9).map {
                PullMenuMotion.bottomUpFadeRank(
                    itemIndex: $0,
                    itemCount: 9,
                    columns: 2
                )
            },
            [4, 4, 3, 3, 2, 2, 1, 1, 0]
        )

        // The accessibility layout presents every destination in one
        // horizontal row, so it fades as one group.
        XCTAssertEqual(
            (0..<9).map {
                PullMenuMotion.bottomUpFadeRank(
                    itemIndex: $0,
                    itemCount: 9,
                    columns: 9
                )
            },
            Array(repeating: 0, count: 9)
        )

        // Horizontal compact-height layouts use three equal columns so the
        // complete directory fits without shrinking the labels.
        XCTAssertEqual(
            (0..<9).map {
                PullMenuMotion.bottomUpFadeRank(
                    itemIndex: $0,
                    itemCount: 9,
                    columns: 3
                )
            },
            [2, 2, 2, 1, 1, 1, 0, 0, 0]
        )
    }

    func testWorkspaceCostBreakdownsAcceptPostgresAggregateCounts() throws {
        // PostgreSQL count(*) may reach an older mobile API deployment as a
        // JSON string, while the current endpoint normalizes it to a number.
        // The phone must load Workspace in either case.
        let stringCount = #"[{"source":"tool","usd":"0.012","count":"3"}]"#.data(using: .utf8)!
        let numericCount = #"[{"model":"gpt-5","usd":"0.024","count":4}]"#.data(using: .utf8)!

        let bySource = try JSONDecoder().decode([WorkspaceCostBreakdown].self, from: stringCount)
        let byModel = try JSONDecoder().decode([WorkspaceModelBreakdown].self, from: numericCount)

        XCTAssertEqual(bySource[0].count, 3)
        XCTAssertEqual(byModel[0].count, 4)
    }

    func testNativeRouteCatalogMatchesTheCompleteWorkspaceMenu() {
        XCTAssertEqual(
            Set(AssistantRoute.allCases),
            Set([
                .chat,
                .chats,
                .activity,
                .goals,
                .approvals,
                .cards,
                .memory,
                .people,
                .documents,
                .skills,
                .capabilities,
                .settings,
                .costs,
                .anomalies,
                .improvements,
            ])
        )
    }

    func testMarkdownPresentationSeparatesRichResponseBlocks() {
        let blocks = AssistantMarkdown.blocks(in: """
        ## Trip brief

        Your **best option** is below.

        - Leave early
        - Keep a flexible fare

        - [x] Compare dates
        - [ ] Book the flight

        > Prices can change quickly.

        | Route | Duration |
        | --- | ---: |
        | SFO → LHR | 10h 20m |

        ---
        """)

        XCTAssertEqual(
            blocks,
            [
                .heading(level: 2, text: "Trip brief"),
                .paragraph("Your **best option** is below."),
                .list([
                    .init(marker: .bullet, text: "Leave early", children: []),
                    .init(marker: .bullet, text: "Keep a flexible fare", children: []),
                ]),
                .list([
                    .init(marker: .task(isComplete: true), text: "Compare dates", children: []),
                    .init(marker: .task(isComplete: false), text: "Book the flight", children: []),
                ]),
                .quote("Prices can change quickly."),
                .table(
                    headers: ["Route", "Duration"],
                    rows: [["SFO → LHR", "10h 20m"]]
                ),
                .divider,
            ]
        )
    }

    func testMarkdownPresentationKeepsAnUnclosedStreamedCodeFenceAsCode() {
        let blocks = AssistantMarkdown.blocks(in: """
        ```swift
        let state = "streaming"
        """)

        XCTAssertEqual(
            blocks,
            [.code(language: "swift", text: "let state = \"streaming\"")]
        )
    }

    private func activityItem(
        title: String?,
        type: String = "scheduled",
        progress: String = "",
        spentUsd: String = "0",
        budgetUsdLimit: String = "1"
    ) -> ActivityItem {
        .init(
            id: "activity",
            type: type,
            status: "done",
            title: title,
            progress: progress,
            trust: "owner",
            spentUsd: spentUsd,
            budgetUsdLimit: budgetUsdLimit,
            updatedAt: "2026-01-01T00:00:00Z",
            archivedAt: nil,
            hasPendingApproval: false
        )
    }

    private func goalRecord(title: String) -> GoalRecord {
        .init(
            id: "goal",
            title: title,
            description: "",
            status: "active",
            priority: 0,
            progress: "",
            nextAction: "",
            targetDate: nil,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            archivedAt: nil,
            mirrorToPrimary: false,
            autonomy: true,
            taintedOrigin: false
        )
    }
}

/// `CardText` turns raw mail headers into display strings. Every case here is a
/// shape Gmail actually sends, so the assertions are about real input, not
/// invented input.
final class CardTextTests: XCTestCase {
    func testDecisionWebRequestKeepsExactURLAndRejectsAmbiguousSummaries() {
        let address = "https://www.yelp.com/search?find_desc=Food&find_loc=San%20Francisco"
        XCTAssertEqual(CardText.decisionWebRequestURL("Fetch the public web page \(address)")?.absoluteString, address)
        for summary in ["Visit \(address)", "Fetch the public web page \(address) then send an email",
            "Fetch the public web page javascript:alert(1)", "Fetch the public web page https://user:secret@example.com",
            "Fetch the public web page ", "Send an email to Katie"] {
            XCTAssertNil(CardText.decisionWebRequestURL(summary), summary)
        }
    }

    func testSnippetFormattingRemovesHighlightMarkupAndDecodesEntities() {
        XCTAssertEqual(CardText.readableSnippet("A <strong>frontend</strong> engineer &amp; designer"),
            "A frontend engineer & designer")
        XCTAssertEqual(CardText.readableSnippet("&lt;strong&gt;Hello&lt;/strong&gt;<br/>Next&nbsp;line &#8212; &#x1F44B;"),
            "Hello Next line — 👋")
        XCTAssertEqual(CardText.readableSnippet("<p>First</p><p>Second</p><script>hidden()</script>"), "First Second")
    }

    func testSnippetCleanupPreservesMailboxesComparisonsAndUnknownEntities() {
        XCTAssertEqual(CardText.readableSnippet("From &lt;a@example.com&gt; and <p@example.com>"),
            "From <a@example.com> and <p@example.com>")
        XCTAssertEqual(CardText.readableSnippet("2 < 3 and 5 > 4; &unknown; &#99999999;"),
            "2 < 3 and 5 > 4; &unknown; &#99999999;")
        XCTAssertEqual(CardText.readableSnippet("[title](https://example.com) **literal text**"),
            "[title](https://example.com) **literal text**")
    }

    private let reference = Date(timeIntervalSince1970: 1_788_401_284) // 2026-09-02T19:08:04-07:00

    // MARK: Timestamps

    func testParsesGmailDateHeaders() {
        // Every spelling below is the same instant, so they all land on it.
        let expected = reference.timeIntervalSince1970
        for header in [
            "Wed, 2 Sep 2026 19:08:04 -0700",
            "Wed, 02 Sep 2026 19:08:04 -0700",
            "Wed, 2 Sep 2026 19:08:04 -0700 (PDT)",
            "2 Sep 2026 19:08:04 -0700",
            // RFC 5322's obsolete two-digit year: 26 is 2026, not the year 26.
            "Wed, 2 Sep 26 19:08:04 -0700",
        ] {
            let date = CardText.timestamp(header)
            XCTAssertNotNil(date, "failed to parse \(header)")
            XCTAssertEqual(date?.timeIntervalSince1970, expected, "wrong instant for \(header)")
        }
    }

    func testParsesGmailHeadersWithOptionalSecondsAndAlphabeticZones() {
        XCTAssertEqual(
            CardText.timestamp("Wed, 2 Sep 2026 19:08 -0700")?.timeIntervalSince1970,
            reference.timeIntervalSince1970 - 4
        )
        XCTAssertEqual(
            CardText.timestamp("Wed, 2 Sep 2026 19:08:04 GMT")?.timeIntervalSince1970,
            reference.timeIntervalSince1970 - 7 * 3600
        )
    }

    func testISO8601StillWins() {
        XCTAssertEqual(
            CardText.timestamp("2026-09-03T02:08:04Z")?.timeIntervalSince1970,
            reference.timeIntervalSince1970
        )
        XCTAssertEqual(
            CardText.timestamp("2026-09-03T02:08:04.250Z")?.timeIntervalSince1970,
            reference.timeIntervalSince1970 + 0.25
        )
    }

    func testRejectsWhatIsNotADate() {
        XCTAssertNil(CardText.timestamp("today"))
        XCTAssertNil(CardText.timestamp(""))
        XCTAssertNil(CardText.timestamp("   "))
        XCTAssertNil(CardText.timestamp("not a date"))
    }

    // MARK: Date labels

    private var fixedCalendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles") ?? .gmt
        return calendar
    }()

    private func label(_ value: String, now: Date) -> String? {
        return CardText.compactDateLabel(
            value,
            now: now,
            calendar: fixedCalendar,
            locale: Locale(identifier: "en_US")
        )
        // `Date.FormatStyle` separates the time from AM/PM with U+202F, a
        // narrow no-break space. That is correct output and the card wants it;
        // it just cannot be typed into an expectation below, so both sides of
        // the comparison get ordinary spaces.
        .map { $0.replacingOccurrences(of: "\u{202F}", with: " ")
                 .replacingOccurrences(of: "\u{00A0}", with: " ") }
    }

    func testTodayIsATimeThisYearIsADayOlderEarnsItsYear() {
        let sameDay = reference.addingTimeInterval(3600)
        XCTAssertEqual(label("Wed, 2 Sep 2026 19:08:04 -0700", now: sameDay), "7:08 PM")

        let laterThatYear = reference.addingTimeInterval(60 * 24 * 3600)
        XCTAssertEqual(label("Wed, 2 Sep 2026 19:08:04 -0700", now: laterThatYear), "Sep 2")

        let nextYear = reference.addingTimeInterval(400 * 24 * 3600)
        XCTAssertEqual(label("Wed, 2 Sep 2026 19:08:04 -0700", now: nextYear), "Sep 2, 2026")
    }

    /// The regression this whole change exists for: the row used to print the
    /// raw header, which the single-line column then cut mid-second.
    func testAGmailHeaderNeverRendersAsARawHeader() {
        let stamp = label("Wed, 2 Sep 2026 19:08:04 -0700 (PDT)", now: reference.addingTimeInterval(400 * 24 * 3600))
        XCTAssertEqual(stamp, "Sep 2, 2026")
        XCTAssertFalse(stamp?.contains(":0") ?? true)
        XCTAssertFalse(stamp?.contains("-0700") ?? true)
    }

    func testShortUnparseableValuesPassThroughAndLongOnesAreDropped() {
        XCTAssertEqual(label("today", now: reference), "today")
        XCTAssertNil(label("", now: reference))
        XCTAssertNil(label("an unparseable forty character date value", now: reference))
    }

    // MARK: Sender names

    func testSenderNameKeepsTheHumanAndDropsTheMachine() {
        let cases: [(String, String)] = [
            ("\"Support at TripIt\" <support@tripit.com>", "Support at TripIt"),
            ("Support at TripIt <support@tripit.com>", "Support at TripIt"),
            ("<support@tripit.com>", "support@tripit.com"),
            ("support@tripit.com", "support@tripit.com"),
            ("\"support@tripit.com\" <support@tripit.com>", "support@tripit.com"),
            ("\"Doe, Jane\" <jane@example.com>", "Doe, Jane"),
            ("\"Jane \\\"JD\\\" Doe\" <jane@example.com>", "Jane \"JD\" Doe"),
            ("", ""),
            ("   ", ""),
        ]
        for (input, expected) in cases {
            XCTAssertEqual(CardText.senderName(input), expected, "input: \(input)")
        }
    }

    func testSenderNameCountsTheRestOfTheList() {
        XCTAssertEqual(
            CardText.senderName("\"Doe, Jane\" <jane@example.com>, bob@example.com"),
            "Doe, Jane +1"
        )
        XCTAssertEqual(
            CardText.senderName("a@example.com, b@example.com, c@example.com"),
            "a@example.com +2"
        )
    }

    /// Deliberate: a half-decoded encoded-word reads as our bug, the address
    /// never does.
    func testEncodedWordFallsBackToTheAddress() {
        XCTAssertEqual(
            CardText.senderName("=?UTF-8?B?U3VwcG9ydA==?= <support@tripit.com>"),
            "support@tripit.com"
        )
    }

    // MARK: Links

    func testGmailURLAddressesTheMessageInTheRightAccount() {
        XCTAssertEqual(
            CardText.gmailURL(id: "18f0a2b3c4d5e6f7", mailbox: "assistant@example.com")?.absoluteString,
            "https://mail.google.com/mail/?authuser=assistant@example.com#all/18f0a2b3c4d5e6f7"
        )
        XCTAssertEqual(
            CardText.gmailURL(id: "18f0a2b3c4d5e6f7", mailbox: "")?.absoluteString,
            "https://mail.google.com/mail/u/0/#all/18f0a2b3c4d5e6f7"
        )
    }

    func testGmailURLRefusesASynthesisedID() {
        XCTAssertNil(CardText.gmailURL(id: "email-0-0", mailbox: "assistant@example.com"))
        XCTAssertNil(CardText.gmailURL(id: "", mailbox: "assistant@example.com"))
    }

    func testPresentationLabelsHideTransportFormatting() {
        XCTAssertEqual(CardText.presentationLabel("SOURCE_MESSAGE"), "Source message")
        XCTAssertEqual(CardText.presentationLabel("source-document"), "Source document")
        XCTAssertEqual(CardText.presentationLabel("MCP"), "MCP")
        XCTAssertEqual(CardText.presentationLabel("Cinema email"), "Cinema email")
    }

    func testActivityHidesInternalPipelineDiagnostics() {
        let diagnostic = ActivityItem(
            id: "activity-1",
            type: "scheduled",
            status: "done",
            title: "Background work",
            progress: "pulse: quiet (no-candidates)",
            trust: "assistant",
            spentUsd: "0",
            budgetUsdLimit: "0.5",
            updatedAt: "2026-09-03T18:00:00Z",
            archivedAt: nil,
            hasPendingApproval: false
        )
        XCTAssertEqual(diagnostic.displayProgress, "")
    }
}

enum RelationshipGraphFixture {
    static func snapshot(count: Int = 18) -> RelationshipGraphSnapshot {
        let names = ["Alex Rivera", "Robin Rivera", "Maya Chen", "Sam Okafor", "Elena Rossi", "Noah Martin", "Northstar Studio", "San Francisco", "Design meetup", "Summer trip", "Iris Park", "Leo Jensen", "Ava Santos", "Owen Lee", "Sofia Costa", "Theo Reed", "Family dinner", "Oakland"]
        let nodes = (0..<count).map { i in RelationshipGraphNode(id: "node-\(i)", label: i < names.count ? names[i] : "Person \(i)", kind: i == 6 ? "organization" : [7, 17].contains(i) ? "place" : [8, 9, 16].contains(i) ? "project" : "person") }
        let edges = (1..<max(1, count)).map { i in edge("edge-\(i)", from: "node-\(i < 6 ? 0 : i < 12 ? 2 : 4)", to: "node-\(i)") }
            + (count > 8 ? [edge("cross", from: "node-1", to: "node-6"), edge("cross2", from: "node-4", to: "node-6"), edge("cross3", from: "node-2", to: "node-4")] : [])
        let labels = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0.label) })
        let namedEdges = edges.map { edge in
            let sentence = "\(labels[edge.subjectId] ?? edge.subjectId) knows \(labels[edge.objectId] ?? edge.objectId)."
            return RelationshipGraphEdge(id: edge.id, subjectId: edge.subjectId, objectId: edge.objectId, predicate: edge.predicate,
                reviewStatus: edge.reviewStatus, sourceContent: sentence,
                presentation: .init(sentence: sentence, label: "Knows", accessibleLabel: sentence), validFrom: nil, validUntil: nil)
        }
        return .init(nodes: nodes, edges: namedEdges, totalEdges: edges.count, truncated: false, focusId: nil)
    }
    static func edge(_ id: String, from: String, to: String) -> RelationshipGraphEdge {
        .init(id: id, subjectId: from, objectId: to, predicate: "knows", reviewStatus: "confirmed", sourceContent: "A synthetic source note.", presentation: .init(sentence: "Alex knows Robin.", label: "Knows", accessibleLabel: "Alex knows Robin."), validFrom: nil, validUntil: nil)
    }
}

extension APIModelsTests {
    func testRelationshipMapUsesFocusSpecificAssertionWordingAndLegacyFallback() throws {
        let forward = KnowledgeAssertionEndpointView(
            assertionId: "assertion-1", semanticRevision: 3,
            focusEntityId: "parent", relatedEntityId: "child", direction: "forward",
            subjectEntityId: "parent", predicate: "parent_of", objectEntityId: "child",
            text: "Parent is the parent of Child", accessibilityText: "Parent is the parent of Child",
            evidenceCount: 2, reviewStatus: "confirmed"
        )
        let inverse = KnowledgeAssertionEndpointView(
            assertionId: "assertion-1", semanticRevision: 3,
            focusEntityId: "child", relatedEntityId: "parent", direction: "inverse",
            subjectEntityId: "parent", predicate: "parent_of", objectEntityId: "child",
            text: "Child is the child of Parent", accessibilityText: "Child is the child of Parent",
            evidenceCount: 2, reviewStatus: "confirmed"
        )
        let presentation = KnowledgePresentation(
            sentence: "Parent is the parent of Child", label: "Parent", accessibleLabel: "Parent is the parent of Child"
        )
        let edge = RelationshipGraphEdge(
            id: "edge-1", subjectId: "parent", objectId: "child", predicate: "parent_of",
            reviewStatus: "confirmed", sourceContent: "Parent is the parent of Child",
            presentation: presentation, validFrom: nil, validUntil: nil,
            endpointViews: [forward, inverse]
        )

        XCTAssertEqual(edge.displayText(focusedAt: "parent"), "Parent is the parent of Child")
        XCTAssertEqual(edge.displayText(focusedAt: "child"), "Child is the child of Parent")
        XCTAssertEqual(edge.accessibilityText(focusedAt: "child"), "Child is the child of Parent")
        XCTAssertEqual(edge.label(focusedAt: "child"), "Child is the child of Parent")
        XCTAssertEqual(edge.displayText(focusedAt: "unrelated"), presentation.sentence)

        let oldPayload = """
        {"id":"old-edge","subjectId":"parent","objectId":"child","predicate":"parent_of",
         "reviewStatus":"confirmed","sourceContent":"Parent is the parent of Child",
         "presentation":{"sentence":"Parent is the parent of Child","label":"Parent",
         "accessibleLabel":"Parent is the parent of Child"},"validFrom":null,"validUntil":null}
        """.data(using: .utf8)!
        let oldEdge = try JSONDecoder().decode(RelationshipGraphEdge.self, from: oldPayload)
        XCTAssertNil(oldEdge.endpointViews)
        XCTAssertEqual(oldEdge.displayText(focusedAt: "child"), "Parent is the parent of Child")
    }

    func testForceGraphUsesTopologyRatherThanDuplicateSourceWeights() {
        let a = RelationshipGraphFixture.edge("a", from: "node-0", to: "node-1")
        let b = RelationshipGraphFixture.edge("b", from: "node-0", to: "node-1")
        var graph = RelationshipGraphFixture.snapshot(count: 2)
        graph.edges = [a, b]
        XCTAssertEqual(graph.links, [GraphLink("node-0", "node-1")])
        XCTAssertEqual(graph.neighborhood(of: "node-0"), Set(["node-0", "node-1"]))
        graph.edges.removeFirst()
        XCTAssertEqual(graph.links.count, 1, "Removing one source must retain the other claim")
    }

    func testForceGraphExpansionReplacesStaleNeighborhoodAndKeepsUnrelatedEdges() {
        let graph = RelationshipGraphFixture.snapshot()
        let replacement = RelationshipGraphSnapshot(nodes: graph.nodes, edges: [RelationshipGraphFixture.edge("new", from: "node-0", to: "node-17")], totalEdges: 1, truncated: false, focusId: "node-0")
        let merged = graph.merging(replacement, around: "node-0")
        XCTAssertEqual(merged.edges.filter { $0.subjectId == "node-0" }.map(\.id), ["new"])
        XCTAssertTrue(merged.edges.contains { $0.id == "cross" })
        XCTAssertEqual(merged.merging(replacement, around: "node-0").edges.count, merged.edges.count)
    }

    func testExpandingAFullMapStillShowsTheFreshNeighbourhood() {
        // A full map used to skip the merge entirely, so a connection saved on
        // a real account — whose map is always full — never appeared.
        let full = RelationshipGraphFixture.snapshot(count: 200)
        let fresh = RelationshipGraphSnapshot(
            nodes: [full.nodes[0], RelationshipGraphNode(id: "new-a", label: "New A", kind: "person"),
                    RelationshipGraphNode(id: "new-b", label: "New B", kind: "place")],
            edges: [RelationshipGraphFixture.edge("fresh-1", from: "node-0", to: "new-a"),
                    RelationshipGraphFixture.edge("fresh-2", from: "new-b", to: "node-0")],
            totalEdges: 2, truncated: false, focusId: "node-0")
        let merged = full.merging(fresh, around: "node-0", keep: ["node-150"], nodeCap: 200)
        XCTAssertEqual(merged.nodes.count, 200, "The window holds its size")
        XCTAssertTrue(merged.edges.contains { $0.id == "fresh-1" })
        XCTAssertTrue(merged.edges.contains { $0.id == "fresh-2" })
        XCTAssertTrue(merged.nodes.contains { $0.id == "node-150" }, "The recent trail is never let go")
        XCTAssertTrue(merged.truncated, "Letting items go is reported as a partial view")
        XCTAssertEqual(merged.edges.filter { $0.subjectId == "node-0" || $0.objectId == "node-0" }.map(\.id).sorted(),
                       ["fresh-1", "fresh-2"], "Fresh claims about the item replace its old ones")
        let ids = Set(merged.nodes.map(\.id))
        XCTAssertTrue(merged.edges.allSatisfy { ids.contains($0.subjectId) && ids.contains($0.objectId) },
                      "No line is left pointing at an item that was let go")
    }

    func testWindowLetsGoOfTheFurthestItemsFirst() {
        // A chain a–b–c–d–e plus an unconnected f: opening a, over capacity,
        // gives up f (unreachable) and then e (furthest) before anything near a.
        let nodes = ["a", "b", "c", "d", "e", "f"].map { RelationshipGraphNode(id: $0, label: $0.uppercased(), kind: "person") }
        let edges = [("a", "b"), ("b", "c"), ("c", "d"), ("d", "e")].map { RelationshipGraphFixture.edge("\($0)\($1)", from: $0, to: $1) }
        let map = RelationshipGraphSnapshot(nodes: nodes, edges: edges, totalEdges: 4, truncated: false, focusId: nil)
        let fresh = RelationshipGraphSnapshot(nodes: [nodes[0], nodes[1]], edges: [edges[0]], totalEdges: 1, truncated: false, focusId: "a")
        let merged = map.merging(fresh, around: "a", nodeCap: 4)
        XCTAssertEqual(Set(merged.nodes.map(\.id)), ["a", "b", "c", "d"])
        XCTAssertFalse(map.merging(fresh, around: "a").truncated, "Under capacity nothing is let go")
    }

    func testGraphPreparationCancelsWithoutChangingItsSeed() throws {
        let graph = RelationshipGraphFixture.snapshot()
        var seed = RelationshipGraphLayout()
        seed.update(nodes: graph.nodes, links: graph.links)
        let original = seed.positions
        var checkpoints = 0
        let cancelled = seed.prepared(maxSteps: 150) {
            checkpoints += 1
            return checkpoints == 3
        }
        XCTAssertNil(cancelled, "An interrupted batch cannot publish a partial force state")
        XCTAssertEqual(checkpoints, 3)
        XCTAssertEqual(seed.positions, original, "Preparation operates on a value copy")
        XCTAssertNil(seed.prepared(maxSteps: 0, isCancelled: { true }), "Cancellation also fences publication without a step")
    }

    func testGraphPreparationMatchesExistingPhysicsAndTransitionsWithoutAJump() throws {
        let graph = RelationshipGraphFixture.snapshot()
        var seed = RelationshipGraphLayout()
        seed.update(nodes: graph.nodes, links: graph.links)
        var expected = seed
        for _ in 0..<150 where !expected.isSettled { expected.step() }
        let prepared = try XCTUnwrap(seed.prepared(maxSteps: 150, isCancelled: { false }))
        XCTAssertEqual(prepared.ids, expected.ids)
        XCTAssertEqual(prepared.positions, expected.positions)
        XCTAssertEqual(prepared.alpha, expected.alpha)
        var transition = prepared.transitioning(from: seed)
        XCTAssertEqual(transition.positions, seed.positions, "The visible seed stays in place at adoption")
        for _ in 0..<100 where transition.positions != prepared.positions { transition.step() }
        XCTAssertEqual(transition.positions, prepared.positions, "Existing position interpolation reaches the prepared state")
        XCTAssertEqual(transition.ids, seed.ids)
    }

    func testForceLayoutKeepsExistingPositionsDuringExpansionAndRemainsFiniteAtCapacity() {
        let graph = RelationshipGraphFixture.snapshot(count: 200)
        var layout = RelationshipGraphLayout()
        layout.update(nodes: Array(graph.nodes.prefix(18)), links: graph.links)
        for _ in 0..<120 { layout.step() }
        let before = Dictionary(uniqueKeysWithValues: zip(layout.ids, layout.positions))
        layout.update(nodes: graph.nodes, links: graph.links)
        for (id, point) in zip(layout.ids, layout.positions) where before[id] != nil { XCTAssertEqual(before[id], point) }
        let start = Date()
        for _ in 0..<120 { layout.step() }
        let elapsed = Date().timeIntervalSince(start)
        let note = XCTAttachment(string: "200 nodes, 120 settling steps: \(elapsed) seconds in simulator test build")
        note.lifetime = .keepAlways; add(note)
        XCTAssertTrue(layout.positions.allSatisfy { $0.x.isFinite && $0.y.isFinite })
        XCTAssertEqual(layout.positions.count, 200)
        layout.move(id: "node-0", to: CGPoint(x: 30, y: 40))
        layout.step(pinned: "node-0")
        XCTAssertEqual(layout.positions[layout.ids.firstIndex(of: "node-0")!], CGPoint(x: 30, y: 40))
    }

    func testGraphGroupsAndConnectionPromptsUseOnlyRecordedTopology() throws {
        let nodes = (0..<6).map { RelationshipGraphNode(id: "n\($0)", label: $0 < 2 ? "Alex" : "Item \($0)", kind: "person") }
        let edges = [RelationshipGraphFixture.edge("a", from: "n0", to: "n2"), RelationshipGraphFixture.edge("b", from: "n1", to: "n2"), RelationshipGraphFixture.edge("c", from: "n3", to: "n4")]
        let graph = RelationshipGraphSnapshot(nodes: nodes, edges: edges, totalEdges: 3, truncated: true, focusId: nil)
        XCTAssertEqual(graph.groups.map { $0.nodes.count }, [3, 2, 1])
        XCTAssertEqual(graph.groups.last?.ids, ["n5"])
        let candidates = graph.connectionCandidates(for: "n0")
        XCTAssertEqual(candidates.first?.node.id, "n1", "Same names must remain distinct entities")
        XCTAssertEqual(candidates.first?.reason, "Both connect to Item 2")
        XCTAssertFalse(candidates.contains { ["n0", "n2"].contains($0.node.id) })
        XCTAssertTrue(candidates.contains { $0.node.id == "n5" && $0.reason.contains("separate group") })
        let bridged = graph.merging(.init(nodes: nodes, edges: edges + [RelationshipGraphFixture.edge("bridge", from: "n0", to: "n3")], totalEdges: 4, truncated: false, focusId: "n0"), around: "n0")
        XCTAssertEqual(bridged.groups.map { $0.nodes.count }, [5, 1])
        XCTAssertEqual(graph.showing(["n0", "n2"]).links.count, 1)
    }

    func testForceLayoutSettlesWithDotsApartAndIslandsInOrbit() {
        let nodes = (0..<12).map { RelationshipGraphNode(id: "n\($0)", label: "Item \($0)", kind: "person") }
        let edges = [RelationshipGraphFixture.edge("a", from: "n0", to: "n1"), RelationshipGraphFixture.edge("b", from: "n2", to: "n3")]
        let graph = RelationshipGraphSnapshot(nodes: nodes, edges: edges, totalEdges: 2, truncated: false, focusId: nil)
        var layout = RelationshipGraphLayout(); layout.update(nodes: nodes, links: graph.links)
        XCTAssertFalse(layout.isSettled)
        layout.settle()
        XCTAssertTrue(layout.isSettled, "The map comes to rest rather than drifting forever")
        let points = layout.positions
        XCTAssertTrue(points.allSatisfy { $0.x.isFinite && $0.y.isFinite })
        for i in points.indices {
            for j in points.indices where j > i {
                XCTAssertGreaterThan(hypot(points[i].x - points[j].x, points[i].y - points[j].y), RelationshipGraphLayout.collisionRadius,
                                     "No two dots sit on top of each other")
            }
            // Gravity keeps loose items near the map instead of flung off it.
            XCTAssertLessThan(hypot(points[i].x, points[i].y), 600)
        }
        let placed = Dictionary(uniqueKeysWithValues: zip(layout.ids, points))
        let linked = hypot(placed["n0"]!.x - placed["n1"]!.x, placed["n0"]!.y - placed["n1"]!.y)
        let loose = hypot(placed["n0"]!.x - placed["n7"]!.x, placed["n0"]!.y - placed["n7"]!.y)
        XCTAssertLessThan(linked, loose, "A link holds its ends closer than strangers")
        let settled = layout.positions
        layout.update(nodes: nodes, links: graph.links)
        XCTAssertEqual(layout.positions, settled)
        XCTAssertTrue(layout.isSettled, "Reloading the same items does not wake the map")
    }

    func testDisconnectedClustersSeparateAndJoiningThemRegroupsWithoutReseeding() {
        let nodes = (0..<12).map { RelationshipGraphNode(id: "n\($0)", label: "Person \($0)", kind: "person") }
        let links = [GraphLink("n0", "n1"), GraphLink("n1", "n2"), GraphLink("n2", "n3"),
                     GraphLink("n4", "n5"), GraphLink("n5", "n6"), GraphLink("n6", "n7"),
                     GraphLink("n8", "n9"), GraphLink("n9", "n10"), GraphLink("n10", "n11")]
        var layout = RelationshipGraphLayout(); layout.update(nodes: nodes, links: links); layout.settle()
        func gap(_ a: String, _ b: String) -> CGFloat {
            let p = layout.position(of: a)!, q = layout.position(of: b)!
            return hypot(p.x - q.x, p.y - q.y)
        }
        XCTAssertGreaterThan(gap("n1", "n5"), gap("n1", "n2") * 1.5, "Separate groups have their own space")
        let before = gap("n1", "n5"), placed = layout.positions
        layout.update(nodes: nodes, links: links + [GraphLink("n1", "n5")])
        XCTAssertEqual(layout.positions, placed, "New connections move through the simulation rather than reseeding the map")
        layout.settle()
        XCTAssertLessThan(gap("n1", "n5"), before * 0.75, "A bridge brings its groups together")
        let settled = layout.positions
        layout.update(nodes: nodes, links: links + [GraphLink("n1", "n5")])
        XCTAssertEqual(layout.positions, settled)
        XCTAssertTrue(layout.isSettled, "Repeated evidence updates do not rearrange the map")
    }

    func testSettledGraphUntanglesCrossedConnections() {
        let graph = RelationshipGraphFixture.snapshot(count: 50)
        var layout = RelationshipGraphLayout(); layout.update(nodes: graph.nodes, links: graph.links); layout.settle()
        func side(_ a: CGPoint, _ b: CGPoint, _ c: CGPoint) -> CGFloat {
            (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)
        }
        var crossings = 0
        for i in graph.links.indices { for j in graph.links.indices where j > i {
            let e = graph.links[i], f = graph.links[j]
            if e.contains(f.a) || e.contains(f.b) { continue }
            let a = layout.position(of: e.a)!, b = layout.position(of: e.b)!, c = layout.position(of: f.a)!, d = layout.position(of: f.b)!
            if side(a,b,c)*side(a,b,d) < 0 && side(c,d,a)*side(c,d,b) < 0 { crossings += 1 }
        } }
        XCTAssertEqual(crossings, 0, "The sparse relationship clusters should settle without crossed lines")
        XCTAssertTrue(layout.isSettled)
    }

    func testConnectionCorridorsClearUnrelatedBubbles() {
        let nodes = ["a", "b", "c"].map { RelationshipGraphNode(id: $0, label: $0, kind: "person") }
        var layout = RelationshipGraphLayout(); layout.update(nodes: nodes, links: [GraphLink("a", "b"), GraphLink("a", "c")])
        layout.move(id: "a", to: CGPoint(x: -90, y: 0))
        layout.move(id: "b", to: CGPoint(x: 90, y: 0))
        layout.move(id: "c", to: .zero)
        layout.settle()
        let a = layout.position(of: "a")!, b = layout.position(of: "b")!, c = layout.position(of: "c")!
        let dx = b.x - a.x, dy = b.y - a.y
        let distance = abs(dx * (c.y - a.y) - dy * (c.x - a.x)) / hypot(dx, dy)
        XCTAssertGreaterThan(distance, layout.radius(of: "c")! + 8, "A bubble must not settle across someone else's line")
    }

    func testDraggedNodePullsItsNeighbourAlong() {
        let nodes = (0..<3).map { RelationshipGraphNode(id: "n\($0)", label: "Item \($0)", kind: "person") }
        let graph = RelationshipGraphSnapshot(nodes: nodes, edges: [RelationshipGraphFixture.edge("a", from: "n0", to: "n1")],
                                              totalEdges: 1, truncated: false, focusId: nil)
        var layout = RelationshipGraphLayout(); layout.update(nodes: nodes, links: graph.links)
        layout.settle()
        func at(_ id: String) -> CGPoint { layout.positions[layout.ids.firstIndex(of: id)!] }
        let neighbour = at("n1"), stranger = at("n2")
        let destination = CGPoint(x: at("n0").x + 400, y: at("n0").y)
        layout.hold(0.28)
        for _ in 0..<90 { layout.move(id: "n0", to: destination); layout.step(pinned: "n0") }
        XCTAssertEqual(at("n0"), destination)
        XCTAssertGreaterThan(at("n1").x - neighbour.x, 150, "The linked item follows the drag")
        XCTAssertLessThan(abs(at("n2").x - stranger.x), at("n1").x - neighbour.x, "An unlinked item mostly stays put")
        layout.hold(0)
        layout.settle(maxSteps: 2000)
        XCTAssertTrue(layout.isSettled, "Letting go lets the map cool and stop")
    }

    func testANewLineBetweenPlacedItemsPullsThemTogether() {
        // The map used to draw a new connection and leave its ends where they
        // were, because only a change of items woke the simulation.
        let graph = RelationshipGraphFixture.snapshot()
        var layout = RelationshipGraphLayout(); layout.update(nodes: graph.nodes, links: graph.links)
        layout.settle(maxSteps: 2000)
        func gap() -> CGFloat {
            let a = layout.position(of: "node-7")!, b = layout.position(of: "node-15")!
            return hypot(a.x - b.x, a.y - b.y)
        }
        let before = gap()
        layout.update(nodes: graph.nodes, links: graph.links + [GraphLink("node-7", "node-15")])
        XCTAssertFalse(layout.isSettled, "A new line wakes the map")
        layout.settle(maxSteps: 2000)
        XCTAssertLessThan(gap(), before, "Its ends are drawn together")
    }

    func testBubblesGrowWithConnectionsAndKeepTheirRoom() {
        XCTAssertLessThan(RelationshipGraphLayout.radius(degree: 0), RelationshipGraphLayout.radius(degree: 1))
        XCTAssertLessThan(RelationshipGraphLayout.radius(degree: 4), RelationshipGraphLayout.radius(degree: 16))
        XCTAssertEqual(RelationshipGraphLayout.radius(degree: 10_000), 28, "A star's centre is capped")
        XCTAssertEqual(RelationshipGraphLayout.radius(degree: 4, size: 2), RelationshipGraphLayout.radius(degree: 4) * 2)
        let graph = RelationshipGraphFixture.snapshot(count: 60)
        var layout = RelationshipGraphLayout(); layout.update(nodes: graph.nodes, links: graph.links)
        layout.settle(maxSteps: 1000)
        let hub = layout.index(of: "node-4")!
        XCTAssertGreaterThan(layout.radii[hub], layout.radii[layout.index(of: "node-40")!])
        for i in layout.ids.indices where i != hub {
            let distance = hypot(layout.positions[i].x - layout.positions[hub].x, layout.positions[i].y - layout.positions[hub].y)
            XCTAssertGreaterThan(distance, layout.radii[i] + layout.radii[hub], "No dot sits inside the hub's bubble")
        }
    }

    func testGraphSettingsRetuneTheLayoutAndDecodeLeniently() throws {
        var layout = RelationshipGraphLayout()
        let graph = RelationshipGraphFixture.snapshot()
        layout.update(nodes: graph.nodes, links: graph.links); layout.settle(maxSteps: 2000)
        var settings = GraphSettings()
        settings.arrows = false
        layout.apply(settings)
        XCTAssertTrue(layout.isSettled, "A display-only change does not move the map")
        settings.repelForce = 2
        layout.apply(settings)
        XCTAssertFalse(layout.isSettled, "A force change is watched taking effect")
        settings.nodeSize = 1.5
        layout.apply(settings)
        XCTAssertEqual(layout.radius(of: "node-0")!, RelationshipGraphLayout.radius(degree: graph.degrees["node-0"]!, size: 1.5), accuracy: 0.001)

        XCTAssertEqual(GraphSettings(data: Data()), GraphSettings())
        let partial = try XCTUnwrap(#"{"nodeSize":1.4,"hiddenKinds":["place"]}"#.data(using: .utf8))
        let decoded = GraphSettings(data: partial)
        XCTAssertEqual(decoded.nodeSize, 1.4)
        XCTAssertEqual(decoded.hiddenKinds, ["place"])
        XCTAssertTrue(decoded.arrows, "A missing setting reads as its default")
        XCTAssertEqual(GraphSettings(data: decoded.data), decoded)
    }

    func testFilteringHidesKindsAndOrphansButKeepsTheSelection() {
        let graph = RelationshipGraphFixture.snapshot()
        var settings = GraphSettings()
        settings.hiddenKinds = ["place"]
        let noPlaces = graph.filtered(by: settings)
        XCTAssertFalse(noPlaces.nodes.contains { $0.kind == "place" })
        XCTAssertTrue(noPlaces.edges.allSatisfy { edge in noPlaces.nodes.contains { $0.id == edge.subjectId } && noPlaces.nodes.contains { $0.id == edge.objectId } })
        settings = GraphSettings(); settings.showOrphans = false
        // Hiding the hub node-0 strands its leaves 1, 3 and 5; node-1 keeps a
        // line to node-6, and a selected orphan stays on screen.
        let strands = graph.filtered(by: settings, hiding: "node-0", keeping: "node-3")
        let ids = Set(strands.nodes.map(\.id))
        XCTAssertFalse(ids.contains("node-0"))
        XCTAssertFalse(ids.contains("node-5"), "An item left with no lines is an orphan")
        XCTAssertTrue(ids.contains("node-1"))
        XCTAssertTrue(ids.contains("node-3"), "The selection never vanishes from under the finger")
        XCTAssertEqual(graph.filtered(by: GraphSettings()).nodes.count, graph.nodes.count)
    }

    func testBackgroundRefreshAddsAndUpdatesWithoutLosingOpenedItems() {
        var map = RelationshipGraphFixture.snapshot()
        let opened = RelationshipGraphNode(id: "opened", label: "Opened by hand", kind: "person")
        map.nodes.append(opened)
        map.edges.append(RelationshipGraphFixture.edge("opened-edge", from: "node-0", to: "opened"))
        var confirmedLater = RelationshipGraphFixture.edge("edge-3", from: "node-0", to: "node-3")
        confirmedLater = RelationshipGraphEdge(id: confirmedLater.id, subjectId: confirmedLater.subjectId, objectId: confirmedLater.objectId,
                                               predicate: "works_with", reviewStatus: "confirmed", sourceContent: "Updated.",
                                               presentation: confirmedLater.presentation, validFrom: nil, validUntil: nil)
        let newcomer = RelationshipGraphNode(id: "new", label: "Learned since", kind: "place")
        let fresh = RelationshipGraphSnapshot(
            nodes: Array(map.nodes.prefix(6)) + [newcomer],
            edges: [confirmedLater, RelationshipGraphFixture.edge("fresh", from: "node-2", to: "new")],
            totalEdges: 2, truncated: true, focusId: nil)
        let refreshed = map.refreshed(with: fresh)
        XCTAssertTrue(refreshed.nodes.contains { $0.id == "new" }, "What the assistant learned blooms in")
        XCTAssertTrue(refreshed.edges.contains { $0.id == "fresh" })
        XCTAssertTrue(refreshed.nodes.contains { $0.id == "opened" }, "A neighbourhood opened by hand stays")
        XCTAssertTrue(refreshed.edges.contains { $0.id == "opened-edge" })
        XCTAssertEqual(refreshed.edges.first { $0.id == "edge-3" }?.predicate, "works_with", "Known claims are brought up to date")
        XCTAssertEqual(refreshed.edges.filter { $0.id == "edge-3" }.count, 1)
        XCTAssertTrue(refreshed.edges.contains { $0.id == "cross" }, "Claims the refresh did not mention are kept")
        let capped = map.refreshed(with: fresh, keep: ["opened"], nodeCap: 12)
        XCTAssertEqual(capped.nodes.count, 12, "The window holds its size")
        XCTAssertTrue(capped.nodes.contains { $0.id == "opened" }, "What the owner is looking at is never let go")
        XCTAssertTrue(capped.nodes.contains { $0.id == "new" }, "Nor is what the refresh just brought")
        XCTAssertTrue(capped.truncated)
    }

    func testGraphViewportZoomKeepsPinchAnchorAndClampsScale() {
        var viewport = GraphViewport(scale: 1.2, offset: CGPoint(x: 30, y: -22))
        let size = CGSize(width: 390, height: 640), anchor = CGPoint(x: 63, y: 97)
        let world = viewport.world(anchor, size: size)
        viewport.zoom(to: 2.4, anchor: anchor, size: size)
        XCTAssertEqual(viewport.screen(world, size: size).x, anchor.x, accuracy: 0.001)
        XCTAssertEqual(viewport.screen(world, size: size).y, anchor.y, accuracy: 0.001)
        viewport.zoom(to: 100, anchor: anchor, size: size); XCTAssertEqual(viewport.scale, 4)
        viewport.zoom(to: 0.001, anchor: anchor, size: size); XCTAssertEqual(viewport.scale, 0.15)
    }
}

final class AssistantConfirmationStateTests: XCTestCase {
    func testFirstTapNeverExecutesAndSecondTapConsumesConfirmation() {
        var state = AssistantConfirmationState()
        let now = Date(timeIntervalSince1970: 1_000)
        XCTAssertFalse(state.tap(now: now))
        XCTAssertTrue(state.tap(now: now.addingTimeInterval(1)))
        XCTAssertNil(state.expiresAt)
        // A third tap starts a fresh confirmation, including after an API failure.
        XCTAssertFalse(state.tap(now: now.addingTimeInterval(2)))
    }

    func testExpiredConfirmationCannotExecuteBeforeTimerResumes() {
        var state = AssistantConfirmationState()
        let now = Date(timeIntervalSince1970: 1_000)
        XCTAssertFalse(state.tap(now: now))
        XCTAssertFalse(state.tap(now: now.addingTimeInterval(AssistantConfirmationState.lifetime)))
        XCTAssertTrue(state.tap(now: now.addingTimeInterval(AssistantConfirmationState.lifetime + 1)))
    }

    func testLeavingOrDisablingControlResetsConfirmation() {
        var state = AssistantConfirmationState()
        XCTAssertFalse(state.tap())
        state.reset()
        XCTAssertNil(state.expiresAt)
        XCTAssertFalse(state.tap())
    }

    func testConfirmationDoesNotAuthorizeAnotherItem() {
        var first = AssistantConfirmationState()
        var second = AssistantConfirmationState()
        XCTAssertFalse(first.tap())
        XCTAssertFalse(second.tap())
        XCTAssertTrue(first.tap())
        XCTAssertNotNil(second.expiresAt)
    }
}


extension APIModelsTests {
    func testNeighboursAndDegreesUseDistinctTopologyInStableOrder() {
        var graph = RelationshipGraphFixture.snapshot(count: 200)
        let neighbors = graph.directNeighbors(of: "node-4")
        XCTAssertGreaterThan(neighbors.count, 180)
        XCTAssertFalse(neighbors.contains { $0.id == "node-4" })
        XCTAssertEqual(graph.degrees["node-4"], neighbors.count)
        let order = neighbors.map(\.id)
        graph.nodes.reverse(); graph.edges.reverse()
        XCTAssertEqual(graph.directNeighbors(of: "node-4").map(\.id), order, "The list does not reshuffle")
        graph.edges.append(graph.edges[0])
        XCTAssertEqual(graph.degrees["node-4"], neighbors.count, "A second source for one link is not a second neighbour")
    }
}

extension APIModelsTests {
    private func familyGraph(_ claims: [(String, String, String, String)], review: String = "confirmed", dated: Bool = false) -> RelationshipGraphSnapshot {
        let names = ["mom": "Morgan", "me": "Alex", "sibling": "Robin", "grandma": "Grandma", "other": "Casey"]
        let nodes = names.map { RelationshipGraphNode(id: $0.key, label: $0.value, kind: "person") }
        let edges = claims.map { id, subject, role, object in
            let sentence = "\(names[subject]!) \(role.replacingOccurrences(of: "_", with: " ")) \(names[object]!)."
            return RelationshipGraphEdge(id: id, subjectId: subject, objectId: object, predicate: role,
                reviewStatus: review, sourceContent: sentence,
                presentation: .init(sentence: sentence, label: role, accessibleLabel: sentence),
                validFrom: dated ? "2020-01-01" : nil, validUntil: nil)
        }
        return .init(nodes: nodes, edges: edges, totalEdges: edges.count, truncated: false, focusId: nil)
    }

    func testFamilySuggestionsOfferMotherOfSiblingFromEitherSavedConnection() throws {
        let graph = familyGraph([("mother", "mom", "mother_of", "me"), ("siblings", "me", "sibling_of", "sibling")])
        for trigger in ["mother", "siblings"] {
            let suggestion = try XCTUnwrap(graph.familyConnectionSuggestions(triggerRelationID: trigger).first)
            XCTAssertEqual(suggestion.subject.id, "mom")
            XCTAssertEqual(suggestion.object.id, "sibling")
            XCTAssertEqual(suggestion.predicate, "mother_of")
            XCTAssertEqual(suggestion.sentence, "Morgan is Robin’s mother.")
            XCTAssertTrue(suggestion.reason.contains("siblings can have different parents"))
            XCTAssertEqual(Set(suggestion.support.map(\.id)), ["mother", "siblings"])
            XCTAssertEqual(suggestion.mutation.subjectId, "mom")
            XCTAssertEqual(suggestion.mutation.objectId, "sibling")
        }
        XCTAssertTrue(graph.familyConnectionSuggestions(triggerRelationID: "unrelated-save").isEmpty)
    }

    func testFamilySuggestionsPreserveInverseChildAndSiblingDirection() throws {
        let graph = familyGraph([("child", "me", "son_of", "mom"), ("siblings", "sibling", "sister_of", "me")])
        let suggestion = try XCTUnwrap(graph.familyConnectionSuggestions(triggerRelationID: "child").first)
        XCTAssertEqual(suggestion.subject.id, "mom")
        XCTAssertEqual(suggestion.object.id, "sibling")
        XCTAssertEqual(suggestion.predicate, "parent_of", "A child's gender cannot tell us the parent's role")
    }

    func testFamilySuggestionsRecognizeExistingInverseClaimsAndAliases() {
        let graph = familyGraph([("mother", "mom", "is_the_mother_of", "me"), ("siblings", "me", "sibling_of", "sibling"),
                                 ("already", "sibling", "daughter_of", "mom")])
        XCTAssertTrue(graph.familyConnectionSuggestions(triggerRelationID: "mother").isEmpty)
    }

    func testFamilySuggestionsDeriveSiblingsAndGrandparentsWithRecordedRoles() throws {
        let children = familyGraph([("one", "mom", "mother_of", "me"), ("two", "mom", "parent_of", "sibling")])
        let sibling = try XCTUnwrap(children.familyConnectionSuggestions(triggerRelationID: "two").first)
        XCTAssertEqual(sibling.predicate, "sibling_of")
        XCTAssertEqual(Set([sibling.subject.id,sibling.object.id]), ["me","sibling"])
        XCTAssertTrue(sibling.reason.contains("half-sibling"))
        let generations = familyGraph([("one", "grandma", "mother_of", "mom"), ("two", "mom", "mother_of", "me")])
        let grandparent = try XCTUnwrap(generations.familyConnectionSuggestions(triggerRelationID: "two").first)
        XCTAssertEqual(grandparent.subject.id, "grandma")
        XCTAssertEqual(grandparent.object.id, "me")
        XCTAssertEqual(grandparent.predicate, "grandmother_of")
    }

    func testFamilySuggestionsExcludeDatedRejectedAndUnknownSupport() {
        let claims = [("mother", "mom", "mother_of", "me"), ("siblings", "me", "sibling_of", "sibling")]
        for review in ["unknown", "rejected"] {
            XCTAssertTrue(familyGraph(claims, review: review).familyConnectionSuggestions().isEmpty)
        }
        XCTAssertTrue(familyGraph(claims, dated: true).familyConnectionSuggestions().isEmpty)
        var graph = familyGraph(claims)
        graph.edges += familyGraph([("declined", "mom", "mother_of", "sibling")], review: "rejected").edges
        XCTAssertTrue(graph.familyConnectionSuggestions().isEmpty)
    }

    func testFamilySuggestionsRetainUnreviewedEvidenceForExplicitReview() throws {
        let graph = familyGraph([("mother", "mom", "mother_of", "me"), ("siblings", "me", "sibling_of", "sibling")], review: "unreviewed")
        let suggestion = try XCTUnwrap(graph.familyConnectionSuggestions().first)
        XCTAssertTrue(suggestion.support.allSatisfy { $0.reviewStatus == "unreviewed" && !$0.sourceContent.isEmpty })
        XCTAssertTrue(graph.edges.allSatisfy { $0.reviewStatus == "unreviewed" }, "Proposing a connection must not confirm its source records")
        XCTAssertFalse(GraphFamilySuggestion.canTrigger("works_at"))
        XCTAssertTrue(GraphFamilySuggestion.canTrigger("is the mother of"))
    }

    func testFamilySuggestionRevalidationDropsRemovedSupportAndAvoidsCycles() throws {
        var graph = familyGraph([("mother", "mom", "mother_of", "me"), ("siblings", "me", "sibling_of", "sibling")])
        let proposal = try XCTUnwrap(graph.familyConnectionSuggestions().first)
        XCTAssertEqual(graph.familyConnectionSuggestions(matchingSuggestionID: proposal.id), [proposal])
        graph.edges.removeAll { $0.id == "siblings" }
        XCTAssertTrue(graph.familyConnectionSuggestions(matchingSuggestionID: proposal.id).isEmpty)
        let cycle = familyGraph([("one", "mom", "parent_of", "me"), ("two", "me", "parent_of", "mom")])
        XCTAssertTrue(cycle.familyConnectionSuggestions().isEmpty, "A parent cycle must not suggest that someone is their own grandparent")
    }

    func testFamilySuggestionsDeduplicateSourcesWithoutCascadingProposals() {
        let graph = familyGraph([("mother", "mom", "mother_of", "me"), ("another-source", "mom", "mother_of", "me"),
                                 ("siblings", "me", "sibling_of", "sibling"), ("next-sibling", "sibling", "sibling_of", "other")])
        let suggestions = graph.familyConnectionSuggestions(triggerRelationID: "mother")
        XCTAssertEqual(suggestions.count, 1)
        XCTAssertEqual(suggestions.first?.object.id, "sibling")
        XCTAssertFalse(suggestions.contains { $0.object.id == "other" }, "An unaccepted suggestion cannot become evidence for another one")
        XCTAssertEqual(Set(suggestions.first!.support.map(\.id)), ["mother", "another-source", "siblings"])
    }
}

extension APIModelsTests {
    func testUntrustedCardIntegersAreExactlyRepresentableOrNil() {
        XCTAssertEqual(JSONValue.number(12).integerValue, 12)
        XCTAssertEqual(JSONValue.number(Double(Int.min)).integerValue, Int.min)
        XCTAssertNil(JSONValue.number(1e30).integerValue)
        XCTAssertNil(JSONValue.number(-1e30).integerValue)
        XCTAssertNil(JSONValue.number(Double(Int.max)).integerValue)
        XCTAssertNil(JSONValue.number(12.5).integerValue)
        XCTAssertNil(JSONValue.number(.infinity).integerValue)
        XCTAssertNil(JSONValue.number(.nan).integerValue)
    }

    func testDuplicateKnowledgeCardNodeIDsAreDroppedWithoutTrapping() {
        let part = MessagePart(type: "data-card", data: .object([
            "kind": .string("knowledge-graph"),
            "nodes": .array([
                .object(["id": .string("same"), "label": .string("First")]),
                .object(["id": .string("same"), "label": .string("Second")]),
            ]),
            "edges": .array([]),
        ]))
        XCTAssertNil(MessageResponseCard(part: part))
    }

    func testOutOfRangeCardMeasurementsAndSheetIntegersDegradeSafely() throws {
        let weather = MessagePart(type: "data-card", data: .object([
            "kind": .string("weather"), "location": .string("Somewhere"),
            "temperature": .string("unknown"), "condition": .string("unknown"),
            "forecast": .object([
                "days": .array([.object([
                    "weekday": .string("Today"), "lowC": .number(1e30), "highC": .number(1e30),
                    "precipPct": .number(1e30),
                ])]),
                "current": .object([
                    "windKmh": .number(1e30), "humidity": .number(1e30), "precipPct": .number(1e30),
                ]),
            ]),
        ]))
        guard case let .weather(_, _, _, _, _, forecast)? = MessageResponseCard(part: weather) else {
            return XCTFail("Expected weather card")
        }
        XCTAssertTrue(forecast.days.isEmpty)
        XCTAssertEqual(forecast.current?.windKmh, nil)
        XCTAssertEqual(forecast.current?.humidity, nil)
        XCTAssertEqual(forecast.current?.precipPct, nil)

        let sheet = MessagePart(type: "data-card", data: .object([
            "kind": .string("sheet-rows"), "rows": .array([.array([.number(1e30)])]),
        ]))
        guard case let .sheetRows(_, _, rows, _, _)? = MessageResponseCard(part: sheet) else {
            return XCTFail("Expected sheet rows card")
        }
        XCTAssertEqual(rows.first?.first, String(1e30))
    }

    func testAvailabilityRequiresExplicitCompletenessAndNamedCalendarCoverage() {
        func decoded(
            complete: JSONValue?,
            calendars: [JSONValue],
            busy: JSONValue? = .array([])
        ) -> (Bool, [String])? {
            var fields: [String: JSONValue] = [
                "kind": .string("availability"),
                "calendarsChecked": .array(calendars),
            ]
            if let complete { fields["complete"] = complete }
            if let busy { fields["busy"] = busy }
            let part = MessagePart(type: "data-card", data: .object(fields))
            guard case let .availability(_, _, _, _, checked, isComplete, _)? = MessageResponseCard(part: part) else {
                return nil
            }
            return (isComplete, checked)
        }

        let missing = decoded(complete: nil, calendars: [.string("Work")])
        XCTAssertFalse(missing?.0 ?? true)
        let missingBusy = decoded(complete: .bool(true), calendars: [.string("Work")], busy: nil)
        XCTAssertFalse(missingBusy?.0 ?? true)
        let calendarSets: [[JSONValue]] = [[], [.string("Work")], [.string("Work"), .string("Family")]]
        for calendars in calendarSets {
            let incomplete = decoded(complete: .bool(false), calendars: calendars, busy: .array([]))
            XCTAssertFalse(incomplete?.0 ?? true)
        }
        let empty = decoded(complete: .bool(true), calendars: [])
        XCTAssertFalse(empty?.0 ?? true)
        let blankNames = decoded(complete: .bool(true), calendars: [.string("  "), .string("\n")])
        XCTAssertEqual(blankNames?.1, [])
        XCTAssertFalse(blankNames?.0 ?? true)
        let checked = decoded(complete: .bool(true), calendars: [.string(" Work ")])
        XCTAssertEqual(checked?.1, ["Work"])
        XCTAssertTrue(checked?.0 ?? false)
    }

    func testAvailabilityRejectsMalformedBusyArraysAndIntervalsAsIncomplete() {
        func decode(busy: JSONValue) -> (Int, Bool)? {
            let part = MessagePart(type: "data-card", data: .object([
                "kind": .string("availability"),
                "calendarsChecked": .array([.string("Work")]),
                "complete": .bool(true),
                "busy": busy,
            ]))
            guard case let .availability(_, _, _, rows, _, complete, _)? = MessageResponseCard(part: part) else {
                return nil
            }
            return (rows.count, complete)
        }

        let valid = JSONValue.object([
            "start": .string("2026-10-07T09:00:00Z"),
            "end": .string("2026-10-07T10:00:00Z"),
            "calendar": .string("Work"),
        ])
        let malformed = JSONValue.object([
            "start": .string("not-a-date"),
            "end": .string("2026-10-07T10:00:00Z"),
        ])
        let reversed = JSONValue.object([
            "start": .string("2026-10-07T11:00:00Z"),
            "end": .string("2026-10-07T10:00:00Z"),
        ])
        let zeroDuration = JSONValue.object([
            "start": .string("2026-10-07T10:00:00Z"),
            "end": .string("2026-10-07T10:00:00Z"),
        ])

        let validResult = decode(busy: .array([valid]))
        XCTAssertEqual(validResult?.0, 1)
        XCTAssertEqual(validResult?.1, true)
        let mixedResult = decode(busy: .array([valid, malformed]))
        XCTAssertEqual(mixedResult?.0, 1)
        XCTAssertEqual(mixedResult?.1, false)
        let reversedResult = decode(busy: .array([reversed]))
        XCTAssertEqual(reversedResult?.0, 0)
        XCTAssertEqual(reversedResult?.1, false)
        let stringResult = decode(busy: .string("empty"))
        XCTAssertEqual(stringResult?.0, 0)
        XCTAssertEqual(stringResult?.1, false)
        let objectResult = decode(busy: .object([:]))
        XCTAssertEqual(objectResult?.0, 0)
        XCTAssertEqual(objectResult?.1, false)
        let allMalformed = decode(busy: .array([malformed, reversed, zeroDuration]))
        XCTAssertEqual(allMalformed?.0, 0)
        XCTAssertEqual(allMalformed?.1, false)
        let emptyResult = decode(busy: .array([]))
        XCTAssertEqual(emptyResult?.0, 0)
        XCTAssertEqual(emptyResult?.1, true)
    }

    func testRepairManualRunFieldDecodesWithOlderServerCompatibility() throws {
        let old = Data(#"{"id":"issue","title":"Synthetic failure","summary":"Reproduce","status":"reported","diagnosis":"","lastError":"","updatedAt":"2026-10-01T00:00:00Z"}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(WorkspaceRepairIssue.self, from: old).manualRunRequested)
        let requested = Data(#"{"id":"issue","title":"Synthetic failure","summary":"Reproduce","status":"reported","diagnosis":"","lastError":"","manualRunRequested":true,"updatedAt":"2026-10-01T00:00:00Z"}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(WorkspaceRepairIssue.self, from: requested).manualRunRequested, true)
    }
}
