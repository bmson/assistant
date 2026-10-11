import ActivityKit
import Foundation

enum AssistantActivityTone: String, Codable, Hashable, Sendable {
    case thinking
    case working
    case waiting
    case done
    case failed
}

struct AssistantThought: Codable, Hashable, Sendable {
    let label: String
    let tone: AssistantActivityTone

    static let thinking = Self(label: "Thinking", tone: .thinking)
    static let replying = Self(label: "Replying", tone: .working)
    static let startingWork = Self(label: "Starting the work", tone: .working)
    static let backgroundWork = Self(label: "Working in the background", tone: .working)
    static let needsYou = Self(label: "Needs you", tone: .waiting)
    static let replyUnavailable = Self(label: "Reply not available", tone: .waiting)
    static let finished = Self(label: "Finished", tone: .done)
    static let stopped = Self(label: "Task stopped", tone: .failed)
    /// A turn the owner ended from the composer, as distinct from one that
    /// failed on its own. Same tone — the turn produced no result either way —
    /// but it should not tell them to open an app they are already looking at.
    static let stoppedByYou = Self(label: "Stopped", tone: .failed)
}

struct AssistantActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let thought: AssistantThought
        let detail: String
        let pendingCount: Int
        let updatedAt: Date
    }

    let agentName: String
    let startedAt: Date
}
