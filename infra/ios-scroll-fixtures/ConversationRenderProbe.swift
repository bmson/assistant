#if DEBUG
/// Test-only aggregate counters for explicit MessageBubble render and parse
/// work. Calls are lock-protected and intentionally silent per event.
final class ConversationRenderProbe {
    struct Snapshot {
        let bodyEvaluations: Int
        let explicitCardParseAttempts: Int
    }

    static let shared = ConversationRenderProbe()
    static let callSitesInstalled = false

    private let lock = NSLock()
    private var active = false
    private var bodyEvaluations = 0
    private var explicitCardParseAttempts = 0

    func begin() {
        lock.lock()
        active = true
        bodyEvaluations = 0
        explicitCardParseAttempts = 0
        lock.unlock()
    }

    func recordBodyEvaluation() {
        lock.lock()
        if active { bodyEvaluations += 1 }
        lock.unlock()
    }

    func recordExplicitCardParseAttempt() {
        lock.lock()
        if active { explicitCardParseAttempts += 1 }
        lock.unlock()
    }

    func snapshotAndReset() -> Snapshot {
        lock.lock()
        let snapshot = Snapshot(
            bodyEvaluations: bodyEvaluations,
            explicitCardParseAttempts: explicitCardParseAttempts
        )
        bodyEvaluations = 0
        explicitCardParseAttempts = 0
        lock.unlock()
        return snapshot
    }

    func end() {
        lock.lock()
        active = false
        bodyEvaluations = 0
        explicitCardParseAttempts = 0
        lock.unlock()
    }
}
#endif
