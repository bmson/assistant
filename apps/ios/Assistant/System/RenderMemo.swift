import Foundation

/// Remembers the result of a pure, expensive derivation so a SwiftUI body does
/// not redo it on every evaluation.
///
/// The transcript is deliberately eager (see `ChatView.conversationSurface`):
/// every row exists when the log opens. `ChatTranscriptRows` isolates changes
/// in the composer, but a streaming reply changes something on every token. Turning a
/// message into views is dominated by Markdown work — splitting the source into
/// blocks, then building an `AttributedString` per block — and that work depends
/// on nothing but the source string, which never changes once a message has
/// settled. Recomputing it per frame is what makes a long conversation drop
/// frames while a reply arrives.
///
/// Bounded, and the newest keys are the ones that survive. A chat log is read
/// from its newest edge, so recency is the right thing to keep; tracking exact
/// usage would cost more bookkeeping than the extra hits are worth.
final class RenderMemo<Key: Hashable, Value>: @unchecked Sendable {
    private let limit: Int
    private let lock = NSLock()
    private var entries: [Key: (value: Value, rank: Int)] = [:]
    private var nextRank = 0

    /// - Parameter limit: how many results to keep. Exceeding it drops the
    ///   oldest quarter, so eviction is amortised over many insertions rather
    ///   than running on every one past the boundary.
    init(limit: Int) {
        self.limit = max(limit, 1)
    }

    /// The remembered value for `key`, computing it only on a miss.
    ///
    /// `compute` runs outside the lock. It is pure and it can be slow — that is
    /// the entire reason this type exists — so holding the lock across it would
    /// let one long parse block every other row that wanted a different key.
    /// Two callers racing the same key both compute it and agree on the answer,
    /// so the loser overwrites an identical value.
    func value(for key: Key, compute: (Key) -> Value) -> Value {
        lock.lock()
        let hit = entries[key]?.value
        lock.unlock()
        if let hit { return hit }

        let computed = compute(key)

        lock.lock()
        entries[key] = (value: computed, rank: nextRank)
        nextRank += 1
        if entries.count > limit { evictOldest() }
        lock.unlock()

        return computed
    }

    /// Called with the lock held.
    private func evictOldest() {
        let survivors = entries
            .sorted { $0.value.rank > $1.value.rank }
            .prefix(limit - (limit / 4))
        entries = Dictionary(uniqueKeysWithValues: survivors.map { ($0.key, $0.value) })
    }
}

extension NSRegularExpression {
    private struct Pattern: Hashable {
        let pattern: String
        /// The options as their raw bits, so the key is a plain value type.
        let options: UInt
    }

    private static let memo = RenderMemo<Pattern, NSRegularExpression?>(limit: 128)

    /// A pattern compiled once and reused.
    ///
    /// Compiling costs considerably more than matching, and the card readers in
    /// `MessageBubble` compile as they match — several of them build the pattern
    /// from parts at each call, so a stored property per site would not cover
    /// them. `NSRegularExpression` is immutable and safe to match on from
    /// several threads, so one instance can serve every caller.
    ///
    /// A pattern that fails to compile is remembered as a failure too: it is a
    /// literal in this app's own source, so it will not compile on a later try
    /// either.
    static func cached(
        _ pattern: String,
        options: NSRegularExpression.Options = []
    ) -> NSRegularExpression? {
        memo.value(for: Pattern(pattern: pattern, options: options.rawValue)) { key in
            try? NSRegularExpression(
                pattern: key.pattern,
                options: NSRegularExpression.Options(rawValue: key.options)
            )
        }
    }
}
