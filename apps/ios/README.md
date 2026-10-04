# Assistant for iOS

The native SwiftUI client keeps the agent runtime on the existing Assistant server. It provides:

- streamed chat with live activity cues;
- background polling for long-running turns and proactive updates;
- native Activity, Goals, Approvals, Documents, and memory summaries;
- a chat-first shell with no persistent navigation chrome; pull beyond the latest message to reveal controls;
- a Live Activity with compact, minimal, and expanded Dynamic Island presentations;
- opt-in local notifications for completed work and approval handoffs;
- replies read aloud on device, from the long-press menu or automatically;
- deliberate confirmation before approving or denying outward actions;
- a Keychain-stored mobile credential, Dynamic Type, dark mode, and Reduce Motion support.

Open findings on the visual and interaction layer are tracked in
[`docs/visual-qa.md`](docs/visual-qa.md). What the chat transcript costs per
frame, and the rules that keep it at 60fps while a reply streams, is
[`docs/render-cost.md`](docs/render-cost.md) — read it before adding a property
to `MessageBubble` or parsing anything in a view body. Getting a build to
TestFlight is [`docs/shipping.md`](docs/shipping.md) — the app does not ship
from CI.

Relationship-map preparation, cancellation and its repeatable synthetic host
benchmark are documented in [`docs/graph-performance.md`](docs/graph-performance.md).
Host solver timings are separate from iPhone rendering and gesture verification.

## Run locally

1. Start the database, agent, and web service with `pnpm dev` (or `docker compose up --build`).
2. Open `Assistant.xcodeproj` in Xcode 26 or newer.
3. Select the `Assistant` scheme and an iPhone simulator.
4. Connect to `http://localhost:3000`. With source development's explicit `AUTH_DEV_BYPASS=true`,
   the access-key field can remain empty.

The project targets iOS 26 and contains no third-party iOS dependencies.

Rich cards arrive composed. The runtime's card compiler picks the facts, the
layout and the actions, checks every value verbatim against what it was
grounded in, and sends the result as a `generated-card` part; the app reads
that part and draws it. The phone does not read a reply and guess at a card —
it used to, with four hand-written kinds and an on-device relevance pass to
choose between them, and that could only ever produce a shape someone had
already thought of. A card whose `grounding` is `answer` was read out of the
reply itself, so it heads the reply rather than replacing it and the prose
keeps what one value cannot carry: the route, the caveats, when to leave.

The log is the owner's to curate. Long-press any card in the conversation —
a reply, a notice, a decision, a rich card — and **Hide from log** takes it
out: the answer that was wrong, the one that ran three screens long, the
afternoon of test prompts. The row is kept and skipped on read rather than
deleted, so the decision reaches the web chat too, holds across reloads and
devices, and can be undone from the bar that appears above the composer. A
hidden message also leaves the history the model is given, because a reply
hidden for being wrong should stop shaping the next one.

## Speech

Replies can be heard rather than read. Long-press any reply for **Speak reply**,
or turn on **Speak replies aloud** in More → Speech and every reply to something
you send is read as it arrives. Synthesis is `AVSpeechSynthesizer`, so it is
entirely on-device: no key, no quota, no network, and nothing about a reply
leaves the phone in order to be said.

What is spoken is not what is drawn. A reply can be a table, a code block, or a
card that stands in for the answer — so the ear gets its own projection of the
same block tree the renderer parses (`Components/SpeakableText.swift`): prose is
spoken, a table is described by its shape, a code block is named once, a
sensitive fact is held back, and an approval is announced without reading its
payload. Speech never decides anything; an approval still has to be opened.

While a reply streams, only blocks the stream has closed are read, and spoken
progress is an offset into the reply rather than a message id — the streamed row
is replaced by the durable one mid-reply, and the ear must not hear the seam.

The neural voices are a download the owner controls, in Settings ›
Accessibility › Spoken Content › Voices; the app picks the best one installed
and says so in More → Speech when only the compact voice is there. Two things
about that pick are worth knowing. Siri's voices are listed on the device and
report themselves as premium, but an ordinary app handed one is spoken in the
compact default instead — so they are filtered out, along with Eloquence and the
novelty voices, and the tie between two equally good voices goes to whichever
one the phone is already set to. And More → Speech has both a **Speed** and,
where more than one voice is installed, a **Voice** — the default pace is a step
above the system's read-aloud rate, which is a dictation pace rather than a
conversational one. Changing either says a line back in the new voice.

Talking back works the other way: tap the microphone button beside the send
button and speak. Transcription is the Speech framework's on-device
`SpeechAnalyzer` — the audio is never written to a file and never leaves the
phone, and the language model is a system asset iOS downloads once and shares
between apps, so the first sentence in a new language waits for it. A tap leaves
the microphone on and the button in its active white state, and a second tap
puts it back to rest; holding the button instead listens only for as long as it
is held, so the gesture itself can bound how long the phone is listening. Either
way the button stays where it is — speaking never takes over the screen — and
the words land in the composer, added to whatever was already typed, with
nothing sent until you send it. A misheard word is ordinary, and this assistant
acts on what it is told.

Hands-free is a separate, deliberate move rather than something a tap can fall
into: use More → Speech → **Talk to the assistant**, or the microphone's
"Talk to the assistant" accessibility action. It is a full screen with no transcript and no composer: the companion
face, a line of what was just said, and the loop — listen, notice the pause that
means your turn is over, send, read the answer, listen again. The microphone
stays open throughout, echo-cancelled, so the assistant can be interrupted
mid-sentence the way a person can. A hands-free turn is sent with `spoken: true`
and the server answers it in a register that survives being heard: a few
sentences, no Markdown, no cue tags, no tables. Approvals and budget decisions
pause listening and offer **Review decision** on screen. Suggestions keep the
conversation moving. Leaving the app ends Talk mode; returning to the app
never silently reopens the microphone.

## System surfaces

Long-running turns start a Live Activity automatically. Tool progress updates its Dynamic Island
line, approval waits remain visible in amber, and completed work settles briefly before the activity
closes. Tapping an attention activity opens the Approvals sheet through `assistant://approvals`.

Notifications are opt-in. Approval requests carry inline **Approve** / **Deny**
actions (device unlock required) and may banner even while the app is open; routine updates post
only while the app is inactive, avoiding duplicate banners while the conversation is visible.
The app icon badge mirrors the pending-approval count. Two delivery paths exist:

- **Local notifications**, raised by the app's own polling for turns it can observe while running.
- **Remote push (APNs)** for proactive notices and approval pings when the app is closed. The app
  asks once after pairing, registers its device token with `POST /api/mobile/v1/devices`, and the
  server-side `push` module (gated on `APNS_*` settings) sends the alerts. Tapping a push opens the
  chat; an approval ping opens the Approvals sheet.

Opt-in background arrival nudges (More → Assistant context) use the coarse significant-change
location service: iOS wakes the app on ~500m moves, the app posts one throttled ping per wake, and
the server's arrival gate decides whether a nudge (e.g. lunch picks in a new area) is warranted.
Requires Always location access, which the app requests only when the toggle is switched on.

## Connect a deployed server

The web UI has a self-serve pairing panel under **Settings → Mobile app**: it shows the server
URL and lets you generate or rotate the access key. The stored key is never displayed — the full
value is revealed once, when it is generated, so copy it into the app's Connection screen right
away.

The app sends the key as a bearer token only to the configured server and stores it with
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Use HTTPS for any non-local server.

The manual path still exists for Cloud Run deployments (where the web process has no writable
`.env`): set `MOBILE_API_TOKEN` in your local `.env` (`openssl rand -hex 32`) and run
`bash infra/gcp/deploy.sh` to publish it to Secret Manager. `deploy.sh` also creates the token
automatically on first provision when it is missing, and a regular release preserves the web
service's existing secret binding.

## MCP connections

In **More → MCP connections**, add a public Streamable HTTP MCP endpoint and give it a name.
Assistant discovers the server's tool list before enabling it. Tool descriptions and results are
treated as untrusted. Calls initially stop for approval. On an approval card, choose
**Always approve**, review the permission, then **Approve and save** to permit future calls to that
one named tool with any arguments from owner tasks, including calls that use outside information. Other tools still
ask. Changing the endpoint, credentials, or cached tool definition requires fresh approval.
Pause or delete the permission under **Standing approvals**. An optional bearer token is encrypted on the server with `MCP_ENC_KEY`, decrypted only at the network
boundary, and never returned to the phone or shown again. OAuth authorization is not yet available.

## Verify

```sh
xcrun simctl list devices available

xcodebuild -project apps/ios/Assistant.xcodeproj \
  -scheme Assistant \
  -destination 'platform=iOS Simulator,id=<SIMULATOR_UDID>' \
  test
```

The mobile API is versioned under `/api/mobile/v1`. It is a presentation transport over existing
application use cases; the phone never receives database or model-provider credentials.
