import Foundation

/// Pure timing policy for mobile chat refreshes. Keeping backoff separate from
/// AppModel makes the user-visible state owner smaller and lets tests lock down
/// network behavior without constructing an API client or a SwiftUI view.
enum PollingPolicy {
    /// A visible call needs fresh questions; a failing connection needs room to
    /// recover. Screens stop after three failures and offer an explicit retry.
    static func callIntervalSeconds(consecutiveFailures: Int) -> Double {
        switch consecutiveFailures {
        case ...0: return 2
        case 1: return 4
        default: return 8
        }
    }

    /// How long the server may hold a poll open before answering "nothing yet".
    ///
    /// Slightly under the service's own 25s ceiling (MAX_CHAT_WAIT_MS) so the
    /// server is always the one that ends the hold, and well under the
    /// request timeout set on the held request itself.
    static let holdMilliseconds: Int64 = 20_000

    /// A response that came back this much faster than the hold we asked for
    /// means nobody held anything — an older server that does not understand
    /// `wait` and answered straight away.
    private static let heldThresholdMilliseconds: Int64 = 2_000

    /// Fast enough to make a just-started reply feel live; once a task has
    /// taken longer, favour battery and server headroom over sub-second polls.
    ///
    /// This is the fallback cadence, used when the server answers immediately
    /// instead of holding. A current server holds, and `gapMilliseconds` keeps
    /// this out of the way.
    static func replyIntervalMilliseconds(attempt: Int, hasTaskID: Bool) -> Int64 {
        if !hasTaskID {
            switch attempt {
            case 0...7: return 650
            case 8...23: return 1_500
            default: return 2_500
            }
        }
        switch attempt {
        case 0...3: return 1_500
        case 4...19: return 3_000
        default: return 5_000
        }
    }

    /// How long to wait before asking again, given what the last poll did.
    ///
    /// When the server held the connection it already did the waiting, so the
    /// next request goes out immediately — that is what makes a held reply
    /// arrive the moment it exists instead of on the next tick of a timer.
    /// When it answered at once the phone must not spin: either it carried
    /// news (ask again promptly, there is likely more coming) or this is a
    /// server too old to hold, and the interval above is the only thing
    /// standing between us and a hot loop on the radio.
    static func gapMilliseconds(
        elapsedMilliseconds: Int64,
        carriedNews: Bool,
        attempt: Int,
        hasTaskID: Bool
    ) -> Int64 {
        let serverHeld = elapsedMilliseconds >= heldThresholdMilliseconds
        if serverHeld { return 0 }
        if carriedNews { return 250 }
        return replyIntervalMilliseconds(attempt: attempt, hasTaskID: hasTaskID)
    }

    /// Idle polling backs off after quiet refreshes and resets immediately on
    /// any server change. It is only used while the scene is active.
    ///
    /// Same fallback role as `replyIntervalMilliseconds`: against a server that
    /// holds, the hold is the wait and `idleGapSeconds` collapses this to
    /// nothing, so an assistant-initiated message lands as it is written rather
    /// than up to a minute and a half later.
    static func idleIntervalSeconds(unchangedPolls: Int) -> Double {
        switch unchangedPolls {
        case 0...2: return 12
        case 3...5: return 24
        case 6...9: return 48
        default: return 90
        }
    }

    /// The idle-loop counterpart of `gapMilliseconds`.
    static func idleGapSeconds(elapsedMilliseconds: Int64, unchangedPolls: Int) -> Double {
        elapsedMilliseconds >= heldThresholdMilliseconds
            ? 0
            : idleIntervalSeconds(unchangedPolls: unchangedPolls)
    }
}
