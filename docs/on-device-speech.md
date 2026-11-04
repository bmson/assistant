# On-device speech: a talking interface on iPhone

Feasibility study for making the iOS client _speak_ its replies — and, later, _listen_ — with no
network round trip, no per-word billing, and no new server module.

Status: **all three phases shipped.** `Components/SpeakableText.swift` projects a reply for the ear
and `System/SpeechPlayer.swift` reads it, with spoken progress surviving the stream-to-durable
handoff; `System/SpeechListener.swift` transcribes on device through `SpeechAnalyzer`, into the
composer on push-to-talk and echo-cancelled in talk mode; `Views/TalkView.swift` is the hands-free
loop, and `spokenReplyLines()` in `packages/core/src/chat-cues.ts` is the register a heard reply is
written in. The sections below are the design as built.

Two limits worth keeping in view. The spoken register applies to the conversational stream only —
an action request routes through the executor, whose reply is read aloud faithfully but was written
for a screen. And everything audio was verified by compiling and by the pure-function tests; voice
quality, ducking, AirPods routing, echo cancellation and the silent switch still need a device pass.

**Verdict: feasible, and cheaper than it looks.** The Apple side is small. `AVSpeechSynthesizer`
is about a hundred lines and costs nothing. The real work is not synthesis — it is deciding what a
card-heavy transcript _sounds_ like, and not saying the same sentence twice across the handoff from
the stream to the durable row.

A naming note first, because the collision is already in the tree: **voice** in this codebase means
the owner's _writing_ voice (`apps/web/app/profile/voice/page.tsx`, `voiceProfile`, `voice_samples`)
— the tone the assistant imitates when it drafts on the owner's behalf. Anything audible should be
called **speech**, **spoken replies**, or **talk mode**. Never "voice mode".

## What the platform gives us

The app targets iOS 26 exclusively (`IPHONEOS_DEPLOYMENT_TARGET = 26.0`, set for every target in
`apps/ios/Assistant.xcodeproj/project.pbxproj`) and carries no third-party iOS dependencies. That
floor is unusually convenient here: it clears the way to both the mature synthesis API and the new
transcription one, with no availability checks and no fallback path to maintain.

### Speaking — AVFoundation

`AVSpeechSynthesizer` + `AVSpeechUtterance`, from AVFoundation. It is on-device, offline, free,
needs no entitlement, and raises **no permission prompt** — the whole of phase 1 can ship without
asking the owner for anything. The synthesizer holds a queue, so utterances can be enqueued per
sentence as a reply streams in. Its delegate reports `willSpeakRangeOfSpeechString`, which is a word
range in the string being spoken: enough to highlight the sentence in the bubble as it is read, and
enough to drive a mouth on the companion face.

The quality tiers deserve care, because they are the one place where the honest answer is "it
depends on what the owner has downloaded":

- `.default` — always present, heavily compressed, audibly mechanical.
- `.enhanced` and `.premium` — neural, genuinely good, and **not downloadable by us**. The owner
  fetches them in Settings → Accessibility → Spoken Content → Voices. An app can enumerate what is
  installed (`AVSpeechSynthesisVoice.speechVoices()`, filtering on `.quality`) but cannot trigger
  the download.
- Siri's own voices are not available to third-party apps at all. Assume they never will be.

So the shipping behaviour is: pick the best installed voice for the locale at runtime, and if only
compact voices exist, say so once — a single dismissible row offering the Settings path — rather
than letting the owner conclude the assistant sounds like a 2011 GPS. Personal Voice
(`AVSpeechSynthesizer.requestPersonalVoiceAuthorization()`) is a later flourish, not a dependency.

Enumerating by `.quality` alone is not enough, and the failure is silent. Siri's voices appear in
`speechVoices()` and report `.premium`, but an utterance from a third-party app carrying one is
spoken in the compact default — so an app that _did_ go looking for a good voice sounds exactly like
one that did not. `SpeechVoices.isUsable` drops them, along with Eloquence (a speech aid, tuned for
speed over naturalness) and the legacy novelty voices; among voices of equal quality the tie goes to
the one the phone is already set to, and then to identifier order, so the assistant does not change
voice between launches.

Three smaller things decide how synthetic the result sounds, and none of them are about the voice:

- **Rate.** `AVSpeechUtteranceDefaultSpeechRate` is a read-a-document pace, audibly slower than
  anyone talks. `SpeechPace` is stored in `UserDefaults` and offered in More → Speech; the default
  is a step above the system rate, and the scale stops well short of the maximum, where even the
  neural voices slur.
- **Cadence.** Headings, list items and card fragments arrive without terminal punctuation, and a
  synthesizer handed a bare fragment gives it no sentence-final fall — every item lands on the same
  note. `SpeechProsody.phrase(from:)` adds the full stop at the audio boundary, leaving the tested
  projection in `SpeakableText` as text.
- **The gap between utterances.** A passage is a block, and a six-item list is six utterances. The
  synthesizer already leaves a pause between them, so the app's own `preUtteranceDelay` is small,
  and zero for the first thing said after silence — a delay before the first word reads as lag, not
  as phrasing.

Pitch and volume are left alone. Both are ways of making a neural voice sound synthetic again.

The audio session needs a deliberate choice, not a default. `.playback` with mode `.spokenAudio`
and `.duckOthers` is the right one for read-aloud: it lowers music instead of stopping it, and it
resumes cleanly. It also **ignores the silent switch**, which is the correct behaviour for a
deliberate "read this to me" tap and the wrong one for auto-speak — so auto-speak should be off by
default and the setting should say plainly that replies will be audible with the ringer off.
Speaking with the screen locked additionally needs `audio` in `UIBackgroundModes`
(`apps/ios/Assistant/Info.plist:43` already declares that array for `location`).

### Listening — two paths, and a free one

1. **Keyboard dictation.** Zero code. The system mic on the keyboard already types into the
   composer today. If "talking interface" mostly means _not typing_, this is already shipped and
   costs nothing to say so.
2. **`SpeechAnalyzer` + `SpeechTranscriber`** (the Speech framework's iOS 26 API). Fully on-device,
   streaming, with volatile results that firm up as context arrives, real punctuation, and no
   short-utterance ceiling. Model assets are system-managed per locale via `AssetInventory`,
   downloaded once and shared across apps — so the app must handle "asset not yet installed" as a
   first-class state, not an error. Given the iOS 26 floor, this is the path to take.
3. `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true` remains as prior art, but there is
   no reason to choose it here.

Either native path needs `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription`
in `Info.plist`, and both prompt the owner.

## What is actually hard, in this codebase

### 1. Deciding what to speak

This is the bulk of the work, and it is entirely ours — Apple has no opinion about it.

The transcript is not prose. `packages/core`'s card compiler sends `generated-card` parts, and
`MessageCard.replacesProse` (`apps/ios/Assistant/Components/MessageBubble.swift:1413`) says outright
that a card grounded in a lookup _stands in for_ the reply rather than heading it. Feeding
`ChatMessage.text` (`apps/ios/Assistant/Models/APIModels.swift:221`) to a synthesizer therefore
fails in two directions at once: for a card-answered turn there is nothing to say, and for an
ordinary turn it reads Markdown punctuation aloud, recites table pipes, and spells out a fenced code
block character by character.

What it needs is a `SpeakableText` projection — a pure function from parts to a string meant for the
ear:

- Walk `AssistantMarkdown.blocks(in:)` (`MessageBubble.swift:4218`), which already parses headings,
  paragraphs, lists, quotes, tables, equations, and code fences into a typed tree. Speech is just a
  different visitor over the same tree.
- Skip code fences and Mermaid diagrams; say "there's a code block" once rather than reading it.
- Reduce a table to its shape and, at most, its first row — "a table, four rows: Monday, 9am,
  …" — never its pipes.
- Drop link URLs and keep their labels; keep list items as sentences with a pause between them.
- For `replacesProse` cards, speak a projection of the card — its title and the two or three facts
  it was grounded in — because the card _is_ the answer.
- Normalise what looks wrong aloud: `AssistantTemperature.localized`
  (`MessageBubble.swift:1587`) already rewrites units; "18°C" should reach the synthesizer as
  "eighteen degrees".

All of this is pure string work with no AVFoundation in sight, which means it is unit-testable in
`apps/ios/AssistantTests` exactly the way `AssistantMarkdownTests.swift` already tests the parser.
That is the single most important structural decision in this plan: **the speakable projection is a
tested pure function, and the synthesizer is a thin protocol-backed shell behind it.**

### 2. Not saying it twice

The turn lifecycle is the one genuine correctness trap.

`AppModel.send` (`apps/ios/Assistant/AppModel.swift:1549`) appends an optimistic assistant row keyed
`stream-<uuid>`, streams deltas into it through `receive(delta:streamID:)`
(`AppModel.swift:1851`), and then `pollForReply` (`AppModel.swift:1877`) reconciles that row against
the durable one the server persisted — removing the `stream-` twin when the real message lands
(`AppModel.swift:2007`). A turn can also be resumed after backgrounding (`resumeInterruptedTurn`,
`AppModel.swift:613`), and a failed socket re-enters through the cursor poll without replaying the
POST.

Anything that speaks must therefore track _spoken progress per turn_, keyed on the stream id and
carried across the swap to the durable id — an offset into the reply, not a set of message ids.
Speak only the suffix past that offset. Get this wrong and the owner hears the last two sentences of
every reply a second time, which is worse than not speaking at all.

The sentence boundary comes almost free: the server already emits `[break]` cues
(`packages/core/src/chat-cues.ts:15`) marking the exact beats where a reply splits into separate
bubbles, and `ChatMessage.textBubbles` (`APIModels.swift:229`) exposes the result. A break is a
paragraph-length pause; sentence ends inside a bubble are ordinary punctuation scanning over the
accumulated delta buffer, holding back any trailing partial sentence until more text arrives.

### 3. Turn-taking, if it is to be hands-free

Half-duplex is easy and full-duplex is a project. Push-to-talk — hold to speak, release to send,
tap anywhere to stop the reply — needs no echo cancellation and no wake word, and covers most of
what "talk to it while cooking" actually means. Listening _while_ speaking (barge-in) requires
`.playAndRecord` with voice-processing I/O enabled on the audio engine's input node, or the
recognizer transcribes the synthesizer. Treat that as its own phase, and do not let it block the
first one.

### 4. What speech must not be allowed to do

The platform is built around approval before any outward-facing action, and the iOS client already
demands deliberate confirmation — device unlock for notification actions, an explicit decision in
`ApprovalsView`. **Spoken input must never be able to approve anything.** "Yes" heard across a room
is not consent, and a transcription error there is unrecoverable in a way a mistyped chat message is
not. Talk mode should surface an approval by saying that one is waiting and stopping there.

## What it does _not_ need

Worth stating plainly, because it is the strongest part of the case:

- **No server change.** Synthesis is client-side. No new module in `assistant.config.ts`, no
  migration, no env var, nothing in `pnpm config:check`.
- **No cost.** No per-character TTS billing, no key, no quota, and it works on a plane.
- **No privacy surface.** The reply never leaves the phone to be spoken. For a self-hosted personal
  assistant whose pitch is that the owner holds their own data, on-device synthesis is not merely
  adequate — it is the version that matches the product.

The one optional server-side improvement is a talk-mode variant of the persona lines in
`companionPersonaLines()` (`packages/core/src/chat-cues.ts:304`): a reply meant for the ear wants to
be shorter and to avoid tables entirely. That is a refinement to make once the client exists, gated
on a flag in the send payload — not a prerequisite.

There is, pleasingly, already a face. The server emits `data-face` cues and the client decodes them
into `CompanionFace` (`APIModels.swift:531`). A talk-mode screen has its visual vocabulary sitting
there unused, needing no new protocol.

## Project mechanics

- `apps/ios/Assistant.xcodeproj/project.pbxproj` is hand-maintained with explicitly assigned UUIDs
  (`C000000000000000000000NN`). Each new Swift file needs a `PBXFileReference`, a `PBXBuildFile`, a
  group entry, and a line in the sources phase — mechanical, but it will not happen by itself.
- AVFoundation and Speech auto-link in Swift; no framework build-phase edits.
- `Info.plist` changes: `audio` added to `UIBackgroundModes` for phase 1's locked-screen playback;
  the two speech/mic usage strings only when listening lands.
- CI (`.github/workflows/ios.yml`) builds and tests on `macos-latest` against a simulator, so it
  will catch compile and unit-test regressions. It cannot catch the ones that matter most: the
  simulator has no enhanced or premium voices and no real mic. Audio quality, ducking against music,
  route changes on AirPods, and the silent switch all need a device pass — which is already how this
  app is QA'd (`apps/ios/docs/visual-qa.md`).

## Suggested phasing

**Phase 1 — Spoken replies.** A play button on an assistant bubble, an auto-speak toggle in
`MoreView` (off by default, alongside the existing `@AppStorage` settings at
`apps/ios/Assistant/Views/MoreView.swift:8`), best-installed-voice selection with the one-time
Settings hint, and the tested `SpeakableText` projection. New files:
`Assistant/System/SpeechPlayer.swift`, `Assistant/Components/SpeakableText.swift`, plus tests.
Roughly one to two days. No server change, no permission prompt, no cost.

**Phase 2 — Voice input.** Document keyboard dictation as the answer that already works, then add
push-to-talk on the composer via `SpeechTranscriber`, including the asset-download state. Two to
three days.

**Phase 3 — Talk mode.** A full-screen hands-free surface built on `CompanionFace`, barge-in with
voice-processing I/O, and a spoken-reply persona variant on the server. About a week, and the only
phase with real unknowns.

Phase 1 is independently shippable and carries the feature's whole first impression. Start there.
