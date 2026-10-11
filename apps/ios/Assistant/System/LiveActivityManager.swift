import ActivityKit
import Foundation

/// What the system surface is currently showing, minus the timestamp.
///
/// Every refresh path in the app reconciles the Island against the inbox, and
/// each of those used to push a fresh `ContentState` (its `updatedAt` is always
/// new) whether or not anything the owner can see had changed. ActivityKit
/// treats every push as an update to schedule and render, so the ones that
/// mattered queued up behind the ones that did not.
struct LiveActivityShown: Equatable, Sendable {
    let thought: AssistantThought
    let detail: String
    let pendingCount: Int
}

/// Runs operations one at a time, in the order they were asked for.
///
/// An operation marked `supersedable` is dropped if anything was asked for
/// after it and before its turn came: the latest word wins, and the states in
/// between never reach the system. The caller still suspends until its own
/// turn is over (run or skipped), so an `await` keeps its meaning. The work
/// runs in a task of its own, so cancelling a caller — a poll loop torn down
/// on backgrounding — cannot strand an operation half done.
@MainActor
final class LatestWinsQueue {
    private var latestTicket = 0
    private var tail: Task<Void, Never>?

    func run(supersedable: Bool, _ operation: @escaping @MainActor () async -> Void) async {
        latestTicket += 1
        let ticket = latestTicket
        let previous = tail
        let turn = Task { @MainActor [weak self] in
            await previous?.value
            guard let self else { return }
            if supersedable, ticket != self.latestTicket { return }
            await operation()
        }
        tail = turn
        await turn.value
    }
}

@MainActor
final class LiveActivityManager {
    static let shared = LiveActivityManager()

    private var current: Activity<AssistantActivityAttributes>?
    private var stateObservationTask: Task<Void, Never>?
    /// The last content handed to the system for `current`. An identical
    /// request is a no-op rather than another update.
    private var shown: LiveActivityShown?

    /// Requests run strictly one after another, and a request that asks for a
    /// state is skipped if a newer request has been made since.
    ///
    /// Without this, two callers could interleave at an `await`: `ensure`
    /// suspended inside `start` while the activity it was replacing ended, a
    /// `dismiss` ran to completion in that gap, and `start` then requested a
    /// brand-new activity — the Island came back after the decision that was
    /// meant to remove it, and stayed until something else noticed.
    private let queue = LatestWinsQueue()

    private init() {}

    func ensure(
        agentName: String,
        thought: AssistantThought,
        detail: String,
        pendingCount: Int = 0
    ) async {
        await serialized(supersedable: true) { [self] in
            await present(agentName: agentName, thought: thought, detail: detail, pendingCount: pendingCount)
        }
    }

    func start(
        agentName: String,
        thought: AssistantThought,
        detail: String,
        pendingCount: Int = 0
    ) async {
        await serialized(supersedable: true) { [self] in
            guard Self.shouldPresentSystemActivity(for: thought, pendingCount: pendingCount) else {
                await endAllImmediately()
                return
            }
            await begin(agentName: agentName, thought: thought, detail: detail, pendingCount: pendingCount)
        }
    }

    func update(thought: AssistantThought, detail: String, pendingCount: Int = 0) async {
        await serialized(supersedable: true) { [self] in
            guard Self.shouldPresentSystemActivity(for: thought, pendingCount: pendingCount) else {
                await endAllImmediately()
                return
            }
            guard current != nil else { return }
            await push(thought: thought, detail: detail, pendingCount: pendingCount)
        }
    }

    func needsAttention(agentName: String, detail: String, pendingCount: Int) async {
        await ensure(agentName: agentName, thought: .needsYou, detail: detail, pendingCount: pendingCount)
    }

    func finish(
        thought: AssistantThought,
        detail: String,
        succeeded _: Bool
    ) async {
        await serialized(supersedable: false) { [self] in
            guard let current else { return }
            let content = Self.content(
                thought: thought,
                detail: detail,
                pendingCount: 0,
                now: .now
            )
            await current.end(content, dismissalPolicy: .immediate)
            self.current = nil
            shown = nil
            stateObservationTask?.cancel()
        }
    }

    func dismiss() async {
        await serialized(supersedable: false) { [self] in
            await endAllImmediately()
        }
    }

    private func serialized(
        supersedable: Bool,
        _ operation: @escaping @MainActor () async -> Void
    ) async {
        await queue.run(supersedable: supersedable, operation)
    }

    private func present(
        agentName: String,
        thought: AssistantThought,
        detail: String,
        pendingCount: Int
    ) async {
        // The system Island belongs to urgent, owner-actionable work only.
        // Generic progress is shown by the in-app crown and must never keep a
        // wide/timed Live Activity alive over the system clock.
        guard Self.shouldPresentSystemActivity(for: thought, pendingCount: pendingCount) else {
            await endAllImmediately()
            return
        }
        if current == nil {
            // After a relaunch the previous process's activity is still on the
            // Island. Taking it over updates it in place; ending it and asking
            // for a new one replays the whole attach animation and costs two
            // round-trips to the system.
            if let existing = Activity<AssistantActivityAttributes>.activities
                .first(where: { $0.activityState == .active }) {
                current = existing
                shown = nil
                observeState(of: existing)
            } else {
                await begin(agentName: agentName, thought: thought, detail: detail, pendingCount: pendingCount)
                return
            }
        }
        await push(thought: thought, detail: detail, pendingCount: pendingCount)
    }

    private func begin(
        agentName: String,
        thought: AssistantThought,
        detail: String,
        pendingCount: Int
    ) async {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        await endAllImmediately()
        let content = Self.content(thought: thought, detail: detail, pendingCount: pendingCount, now: .now)

        do {
            let activity = try Activity<AssistantActivityAttributes>.request(
                attributes: AssistantActivityAttributes(agentName: agentName, startedAt: .now),
                content: content,
                pushType: nil
            )
            current = activity
            shown = Self.shown(for: content)
            observeState(of: activity)
        } catch {
            current = nil
            shown = nil
        }
    }

    private func push(thought: AssistantThought, detail: String, pendingCount: Int) async {
        guard let current else { return }
        let content = Self.content(thought: thought, detail: detail, pendingCount: pendingCount, now: .now)
        let next = Self.shown(for: content)
        guard shown != next else { return }
        shown = next
        await current.update(content)
    }

    nonisolated static func shown(
        for content: ActivityContent<AssistantActivityAttributes.ContentState>
    ) -> LiveActivityShown {
        LiveActivityShown(
            thought: content.state.thought,
            detail: content.state.detail,
            pendingCount: content.state.pendingCount
        )
    }

    nonisolated static func content(
        thought: AssistantThought,
        detail: String,
        pendingCount: Int,
        now: Date
    ) -> ActivityContent<AssistantActivityAttributes.ContentState> {
        let state = AssistantActivityAttributes.ContentState(
            thought: thought,
            detail: safeDetail(for: thought, proposed: detail),
            pendingCount: pendingCount,
            updatedAt: now
        )
        return ActivityContent(
            state: state,
            staleDate: staleDate(for: thought, now: now),
            relevanceScore: relevanceScore(for: thought)
        )
    }

    private func observeState(of activity: Activity<AssistantActivityAttributes>) {
        stateObservationTask?.cancel()
        stateObservationTask = Task { [weak self] in
            for await state in activity.activityStateUpdates {
                guard !Task.isCancelled else { return }
                if state == .ended || state == .dismissed {
                    guard let self, self.current?.id == activity.id else { return }
                    self.current = nil
                    self.shown = nil
                    return
                }
            }
        }
    }

    private func endAllImmediately() async {
        stateObservationTask?.cancel()
        current = nil
        shown = nil
        let activities = Activity<AssistantActivityAttributes>.activities
        guard !activities.isEmpty else { return }
        // Concurrent, so a stray second activity does not double the wait.
        await withTaskGroup(of: Void.self) { group in
            for activity in activities {
                group.addTask { await activity.end(activity.content, dismissalPolicy: .immediate) }
            }
        }
    }

    nonisolated private static func staleDate(for thought: AssistantThought, now: Date) -> Date? {
        switch thought.tone {
        case .thinking, .working:
            now.addingTimeInterval(60)
        case .waiting, .done, .failed:
            nil
        }
    }

    /// The only system Live Activity is a live approval. Generic task failures
    /// and other attention states belong in Activity, where they cannot be
    /// mistaken for a decision the owner can make on the Approvals screen.
    nonisolated static func shouldPresentSystemActivity(
        for thought: AssistantThought,
        pendingCount: Int
    ) -> Bool {
        thought.tone == .waiting && pendingCount > 0
    }

    nonisolated private static func relevanceScore(for thought: AssistantThought) -> Double {
        switch thought.tone {
        case .waiting: 1
        case .failed: 0.9
        case .working: 0.75
        case .thinking: 0.65
        case .done: 0.45
        }
    }

    /// A concise, non-sensitive activity description that is safe to show in
    /// both the system Live Activity and the in-app activity crown.
    nonisolated static func safeDetail(for thought: AssistantThought, proposed detail: String) -> String {
        switch thought.tone {
        case .thinking:
            return "Preparing a response"
        case .waiting:
            return "A decision is ready to review"
        case .done:
            return "Your result is ready"
        case .failed:
            if thought == .stoppedByYou { return "You stopped this turn" }
            if thought == .stopped, detail == "Task cancelled; external effects are not reversed" {
                return detail
            }
            return "Open Assistant for details"
        case .working:
            if detail.range(of: #"^Step \d+$"#, options: .regularExpression) != nil {
                return detail
            }
            if thought == .replying { return "Writing a response" }
            if thought == .backgroundWork { return "Continuing in the background" }
            return "Working on your request"
        }
    }

}
