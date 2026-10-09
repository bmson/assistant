import AVFoundation
import Foundation

/// The assistant's voice, on the phone and nowhere else.
///
/// `AVSpeechSynthesizer` runs entirely on device: no key, no quota, no network,
/// and nothing about a reply leaves the phone in order to be said out loud. For
/// an assistant whose whole claim is that the owner holds their own data, that
/// is not a compromise — it is the version that matches the product.
///
/// Passages are enqueued rather than played one at a time. The synthesizer owns
/// the queue, so a reply can be spoken as it streams in: each finished block
/// joins the end of the line and the speech never stops between them.
@MainActor
final class SpeechPlayer: ObservableObject {
    static let shared = SpeechPlayer()

    /// The id used while sampling a voice from the settings screen. Nothing on
    /// screen is keyed to it, so no bubble lights up for a preview.
    static let previewID = "speech-preview"

    /// The message being read, if any. Nil the instant the queue drains.
    @Published private(set) var speakingMessageID: String?

    private let synthesizer = AVSpeechSynthesizer()
    private let observer = SpeechQueueObserver()
    private var sessionIsActive = false
    private var queueGeneration = 0
    private var utteranceGenerations: [ObjectIdentifier: Int] = [:]

    /// Resolving a voice walks every voice installed on the phone. The answer
    /// changes only when the owner picks a different one or installs one, and a
    /// streaming reply asks for it once per block — so it is held, not redone.
    private var resolvedVoice: (key: String, voice: AVSpeechSynthesisVoice?)?

    private init() {
        synthesizer.delegate = observer
        observer.onQueueDrained = { [weak self] utteranceID in
            Task { @MainActor [weak self] in self?.queueDidDrain(after: utteranceID) }
        }
    }

    var isSpeaking: Bool { speakingMessageID != nil }

    func isSpeaking(_ messageID: String) -> Bool { speakingMessageID == messageID }

    /// Read this message from the top, whatever was being said before.
    func speak(_ passages: [String], for messageID: String) {
        stop()
        enqueue(passages, for: messageID)
    }

    /// Add to what is already being said. Used by the streaming path, where
    /// each finished block of a reply arrives while the one before it is still
    /// being read.
    func enqueue(_ passages: [String], for messageID: String) {
        let phrases = passages.compactMap(SpeechProsody.phrase(from:))
        guard !phrases.isEmpty else { return }
        if let current = speakingMessageID, current != messageID { queueGeneration += 1 }
        activateSession()
        speakingMessageID = messageID
        // A passage landing behind speech already in progress gets the beat
        // that separates one block of writing from the next. The first thing
        // said after silence does not: a pause before the very first word is
        // heard as the app being slow, not as phrasing.
        var follows = synthesizer.isSpeaking || synthesizer.isPaused
        for phrase in phrases {
            let next = utterance(for: phrase, follows: follows)
            utteranceGenerations[ObjectIdentifier(next)] = queueGeneration
            synthesizer.speak(next)
            follows = true
        }
    }

    /// Say one line in the voice and at the pace currently chosen, so picking
    /// either in settings is a thing you hear rather than a thing you read.
    func preview() {
        speak(["This is how I'll sound."], for: SpeechPlayer.previewID)
    }

    /// The owner changed which voice to use, or came back from Settings having
    /// installed one. Drop what was resolved so the next utterance re-picks.
    func voicePreferenceChanged() {
        resolvedVoice = nil
    }

    func stop() {
        queueGeneration += 1
        if synthesizer.isSpeaking || synthesizer.isPaused {
            synthesizer.stopSpeaking(at: .immediate)
        }
        speakingMessageID = nil
        deactivateSession()
    }

    /// Stop only if this particular message is the one being read — used where
    /// a row is hidden or replaced and its speech has outlived it.
    func stop(messageID: String) {
        guard speakingMessageID == messageID else { return }
        stop()
    }

    private func queueDidDrain(after utteranceID: ObjectIdentifier) {
        let callbackGeneration = utteranceGenerations.removeValue(forKey: utteranceID)
        guard callbackGeneration == queueGeneration,
              !synthesizer.isSpeaking, !synthesizer.isPaused else { return }
        utteranceGenerations = utteranceGenerations.filter { $0.value == queueGeneration }
        speakingMessageID = nil
        deactivateSession()
    }

    // MARK: - Utterances

    private func utterance(for phrase: String, follows: Bool) -> AVSpeechUtterance {
        let utterance = AVSpeechUtterance(string: phrase)
        utterance.voice = voice()
        utterance.rate = SpeechSettings.pace.rate
        // Pitch and volume are left where the voice put them. Both are ways of
        // making a neural voice sound synthetic again.
        utterance.preUtteranceDelay = follows ? SpeechProsody.blockPause : 0
        return utterance
    }

    private func voice() -> AVSpeechSynthesisVoice? {
        let language = AVSpeechSynthesisVoice.currentLanguageCode()
        let chosen = SpeechSettings.voiceIdentifier
        let key = "\(language)|\(chosen ?? "")"
        if let cached = resolvedVoice, cached.key == key { return cached.voice }
        let resolved = SpeechVoices.voice(identifier: chosen, language: language)
        resolvedVoice = (key, resolved)
        return resolved
    }

    // MARK: - Audio session

    /// `.spokenAudio` with `.duckOthers` is the read-aloud contract: music drops
    /// under the assistant's voice and comes back up, rather than stopping.
    ///
    /// This category also ignores the ring/silent switch, which is right for a
    /// deliberate "read this to me" and wrong for anything the owner did not
    /// ask for — which is why speaking replies automatically is opt-in and says
    /// so where it is turned on.
    private func activateSession() {
        guard !sessionIsActive else { return }
        let session = AVAudioSession.sharedInstance()
        // Talk mode holds the session open for recording so the microphone can
        // stay live while this speaks. Taking it back to playback underneath
        // that would close the ear mid-sentence, so leave it as it is.
        guard session.category != .playAndRecord else { return }
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
            sessionIsActive = true
        } catch {
            // A session this app could not claim is a silent reply, not a
            // broken one. Speaking is never the point of the turn.
        }
    }

    private func deactivateSession() {
        guard sessionIsActive else { return }
        sessionIsActive = false
        // Other audio only resumes on a deactivation that says so.
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
}

/// The small adjustments between a passage that is correct and speech that
/// sounds spoken. Pure, and tested as such.
enum SpeechProsody {
    /// The beat between two blocks of writing. Long enough to hear as a
    /// paragraph break, short enough that a six-item list does not turn into
    /// six separate announcements — which, stacked on the pause a synthesizer
    /// already leaves between utterances, is most of what "stilted" means.
    static let blockPause: TimeInterval = 0.05

    /// A passage ready to be said, or nil if there is nothing in it to say.
    ///
    /// Headings, list items and card fragments arrive without terminal
    /// punctuation, and a synthesizer handed a bare fragment gives it no
    /// sentence-final fall: the pitch stays level and every item lands on the
    /// same note. A full stop costs nothing and buys the cadence back.
    static func phrase(from passage: String) -> String? {
        let text = passage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return isPunctuated(text) ? text : text + "."
    }

    /// A comma or a colon counts: both already tell the voice what to do with
    /// the end of the line, and "Run this:" is meant to lean into what follows
    /// rather than close.
    private static func isPunctuated(_ text: String) -> Bool {
        var tail = Substring(text)
        while let last = tail.last, closers.contains(last) { tail = tail.dropLast() }
        guard let last = tail.last else { return true }
        return marks.contains(last)
    }

    private static let closers: Set<Character> = ["\"", "'", "”", "’", ")", "]", "»"]
    private static let marks: Set<Character> = [
        ".", "!", "?", ",", ";", ":", "…",
        // The full-width forms, for the locales that use them.
        "。", "！", "？", "、", "，",
    ]
}

/// Which installed voice the assistant speaks with.
///
/// The tiers matter more than anything else about how this feature is received.
/// `.default` voices are compressed and audibly mechanical; `.enhanced` and
/// `.premium` are neural and genuinely good. An app cannot download the good
/// ones — the owner fetches them in Settings › Accessibility › Spoken Content ›
/// Voices — and Siri's own voices are not available to third-party apps at all.
/// So: take the best of what is installed, let the owner override it, and say
/// once, where the setting lives, that better ones exist.
enum SpeechVoices {

    /// A voice reduced to what picking one depends on.
    ///
    /// The ranking is the part worth testing and the part that is easiest to
    /// get wrong, so it works on this rather than on `AVSpeechSynthesisVoice` —
    /// which cannot be constructed for a voice that is not installed, and would
    /// otherwise make the tests a report on whatever machine ran them.
    struct Candidate: Equatable {
        let identifier: String
        let name: String
        let language: String
        let quality: AVSpeechSynthesisVoiceQuality

        init(identifier: String, name: String, language: String, quality: AVSpeechSynthesisVoiceQuality) {
            self.identifier = identifier
            self.name = name
            self.language = language
            self.quality = quality
        }

        init(_ voice: AVSpeechSynthesisVoice) {
            self.init(
                identifier: voice.identifier,
                name: voice.name,
                language: voice.language,
                quality: voice.quality
            )
        }

        /// One of the neural voices, rather than the compressed one that ships
        /// with every phone. False is what makes the hint pointing at Settings
        /// worth showing.
        var isNatural: Bool { quality != .default }

        /// What the tier is called where the owner chooses between them —
        /// Apple's own words in Settings, so the two screens agree.
        var qualityLabel: String {
            switch quality {
            case .premium: "Premium"
            case .enhanced: "Enhanced"
            default: "Compact"
            }
        }
    }

    /// The voice to speak with: the one the owner picked, if it is still
    /// installed and usable, and otherwise the best of what is there.
    static func voice(identifier: String?, language: String) -> AVSpeechSynthesisVoice? {
        if let identifier,
           let chosen = AVSpeechSynthesisVoice(identifier: identifier),
           isUsable(Candidate(chosen)) {
            return chosen
        }
        let installed = AVSpeechSynthesisVoice.speechVoices()
        let systemDefault = AVSpeechSynthesisVoice(language: language)
        if let best = best(
            in: installed.map(Candidate.init),
            language: language,
            systemDefault: systemDefault?.identifier
        ), let match = installed.first(where: { $0.identifier == best.identifier }) {
            return match
        }
        return systemDefault
    }

    /// Everything the owner could reasonably be offered for this language,
    /// best first. Empty is a real answer on a phone carrying one compact
    /// voice, and the picker should not be shown for a choice of one.
    static func choices(language: String = AVSpeechSynthesisVoice.currentLanguageCode()) -> [Candidate] {
        ranked(AVSpeechSynthesisVoice.speechVoices().map(Candidate.init), language: language, systemDefault: nil)
    }

    /// Pure, so the ranking can be reasoned about without an audio stack.
    static func best(
        in candidates: [Candidate],
        language: String,
        systemDefault: String? = nil
    ) -> Candidate? {
        ranked(candidates, language: language, systemDefault: systemDefault).first
    }

    private static func ranked(
        _ candidates: [Candidate],
        language: String,
        systemDefault: String?
    ) -> [Candidate] {
        let usable = candidates.filter(isUsable)
        let exact = usable.filter { $0.language == language }
        let pool = exact.isEmpty
            ? usable.filter { $0.language.hasPrefix(String(language.prefix(2))) }
            : exact
        return pool.sorted { lhs, rhs in
            let left = rank(lhs, systemDefault: systemDefault)
            let right = rank(rhs, systemDefault: systemDefault)
            if left != right { return left > right }
            // Nothing left to choose on. Order by identifier rather than by
            // whatever order the system happened to enumerate in, so the
            // assistant does not change voice between launches.
            return lhs.identifier < rhs.identifier
        }
    }

    /// Quality first, and then — among equals — the voice the owner already
    /// hears everywhere else on the phone. Two premium voices are both good;
    /// the one they chose in Settings is the one they meant.
    private static func rank(_ candidate: Candidate, systemDefault: String?) -> (Int, Int) {
        let tier: Int = switch candidate.quality {
        case .premium: 3
        case .enhanced: 2
        default: 1
        }
        return (tier, candidate.identifier == systemDefault ? 1 : 0)
    }

    /// Not every installed voice can be spoken by an ordinary app, and not
    /// every one that can should be.
    ///
    /// - Siri's voices are listed on the device but reserved. Hand one to an
    ///   utterance and the synthesizer quietly falls back to the compact
    ///   default — which is how an app that *did* go looking for a premium
    ///   voice still ends up sounding like a 2011 GPS.
    /// - Eloquence ships for people who read by ear all day and want speed over
    ///   naturalness. It shares the `.default` tier with the ordinary compact
    ///   voices, and picking one for a chat reply is never the intent.
    /// - The legacy novelty voices are jokes, and sound like it.
    static func isUsable(_ candidate: Candidate) -> Bool {
        let identifier = candidate.identifier.lowercased()
        if identifier.contains(".siri") || identifier.contains("siri_") { return false }
        if identifier.contains("eloquence") { return false }
        if identifier.hasPrefix("com.apple.speech.synthesis.voice.") { return false }
        return true
    }
}

/// `AVSpeechSynthesizerDelegate` makes no promise about which queue it calls
/// back on, so the delegate is its own object and hops to the main actor rather
/// than making `SpeechPlayer` pretend to be reachable from anywhere.
private final class SpeechQueueObserver: NSObject, AVSpeechSynthesizerDelegate {
    var onQueueDrained: (@Sendable (ObjectIdentifier) -> Void)?

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        // More passages may already be queued behind this one; the reply is
        // only over when nothing is left to say.
        guard !synthesizer.isSpeaking else { return }
        onQueueDrained?(ObjectIdentifier(utterance))
    }

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance
    ) {
        onQueueDrained?(ObjectIdentifier(utterance))
    }
}

/// Where the speech preferences live. Read from `AppModel` as well as the
/// settings screen, so the keys are defined once.
enum SpeechSettings {
    static let speakRepliesKey = "speech.speakRepliesAloud"
    static let paceKey = "speech.pace"
    static let voiceKey = "speech.voiceIdentifier"

    static var speakRepliesAloud: Bool {
        UserDefaults.standard.bool(forKey: speakRepliesKey)
    }

    static var pace: SpeechPace {
        SpeechPace(rawValue: UserDefaults.standard.string(forKey: paceKey) ?? "") ?? .default
    }

    /// The voice the owner picked, or nil for "whichever is best installed".
    static var voiceIdentifier: String? {
        let stored = UserDefaults.standard.string(forKey: voiceKey) ?? ""
        return stored.isEmpty ? nil : stored
    }
}

/// How fast the assistant talks.
///
/// `AVSpeechUtteranceDefaultSpeechRate` is the system's read-a-document pace,
/// and it is slower than anyone speaks: a reply in a chat is conversation, not
/// dictation, and at the default rate a two-sentence answer takes long enough
/// that people reach for the screen. So the default here sits a step above it,
/// and the scale stops well short of `AVSpeechUtteranceMaximumSpeechRate`,
/// where even the neural voices start to slur.
enum SpeechPace: String, CaseIterable, Identifiable {
    case relaxed
    case steady
    case brisk
    case quick

    static let `default` = SpeechPace.brisk

    var id: String { rawValue }

    var label: String {
        switch self {
        case .relaxed: "Relaxed"
        case .steady: "Steady"
        case .brisk: "Brisk"
        case .quick: "Quick"
        }
    }

    /// Clamped, because the multipliers are relative to a system constant and a
    /// rate outside the allowed range is simply ignored.
    var rate: Float {
        let rate = AVSpeechUtteranceDefaultSpeechRate * multiplier
        return min(max(rate, AVSpeechUtteranceMinimumSpeechRate), AVSpeechUtteranceMaximumSpeechRate)
    }

    private var multiplier: Float {
        switch self {
        case .relaxed: 0.9
        case .steady: 1.0
        case .brisk: 1.12
        case .quick: 1.26
        }
    }
}
