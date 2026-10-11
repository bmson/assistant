# Phone calls

The assistant can place a phone call for you and hold the conversation live —
book a table, ask opening hours, chase an order — then report back in chat.

## Setting it up

1. `pnpm setup:phone` (run it yourself, signed in to gcloud). It checks your
   Twilio credentials, stores the Auth Token in Secret Manager, uses a number
   you rent or buys one after you confirm the price, points its webhooks at the
   agent, and updates the services (calls module on, one-hour request timeout,
   and optionally Vertex AI for Gemini Live).
2. Settings → AI providers → **Voice model**: add a suggested voice model and
   choose it. OpenAI Realtime needs an OpenAI API key (platform.openai.com —
   a ChatGPT subscription is not API access); Gemini Live bills to your Google
   Cloud project.
3. In chat: "call my phone and ask what I want for dinner" is a good first test.

## What happens on a call

- The assistant proposes `phone.call` with a brief: number, goal, what it may
  share, what it may agree to, hard limits, time limit, voicemail behaviour.
  **Every call needs your approval**; no policy or autonomy grant skips it.
  Emergency, short-code, premium-rate and out-of-country numbers are refused
  before an approval is even shown.
- When answered, the phone network first plays a fixed line: *"Hi, this is an
  AI assistant calling on behalf of …. This call is transcribed."* The model
  cannot skip or reword it.
- If an unknown-caller screener answers, the assistant gives its name and
  reason for calling, then stays on the line for a person. It repeats the AI
  and transcription disclosure when a person joins. A screener is not treated
  as voicemail just because an automated voice answered.
- On actual voicemail, the assistant follows the approved choice to leave the
  specified message after the beep or end the call without a message.
- The live model sees only the approved brief — not your memory or mail — and
  treats everything the other person says as information, never instructions.
- If they need a decision outside the brief, the assistant puts them on hold
  and asks you (push notification with a link to the call). Answer on the web
  Calls page or in the iPhone app; after about a minute without an answer it
  tells them it will confirm later.
- You can hang up any call from its Calls page.
- When the call ends, the task that asked for it resumes with the outcome,
  summary, the facts noted and the transcript. The other party's words taint
  the task, so any follow-up that sends or books something needs approval.

## Limits and costs

| Setting | Default | Meaning |
| --- | --- | --- |
| `CALL_MAX_MINUTES` | 15 | Hard ceiling on one call; Twilio also enforces it |
| `CALL_DAILY_LIMIT` | 10 | Calls per rolling 24 hours |
| `CALL_ALLOWED_COUNTRY_CODES` | `1` | Country codes that may be dialed |

One call at a time. Before dialing, the worst case (every allowed minute of
line time plus live model) is held against your budget; at the end it is
settled to Twilio's billed minutes and the model's reported audio tokens, both
visible on the Costs page. Audio is never recorded; the transcript is kept on
the call.

## How it works

`phone.call` checkpoints a `call_pending` sentinel and parks the task exactly
like a browser or code job. Twilio dials with inline TwiML: the disclosure
`<Say>`, then `<Connect><Stream>` to `wss://<agent>/voice/stream` carrying a
one-shot token. The agent bridges Twilio's μ-law media to the realtime model
(`@assistant/core/realtime-voice`). It buffers up to ten seconds of incoming
audio only while the model connects, then forwards audio immediately. The
asynchronous answering-machine verdict is stored for diagnostics; it never
ends a live call by itself. If no caller speech is detected shortly after the
connection, the assistant introduces itself and states the approved reason for
calling.

The bridge tracks how much of the model's speech is still queued on the line,
so an interruption tells the model exactly what the other person heard and
`end_call` waits for the goodbye to finish playing. Tool results ask the model
to speak again only when the other person is owed a reply: an owner's answer
does, a fact noted alongside speech or keys pressed into a phone menu do not.
If the voice model's connection drops mid-call, the bridge reconnects (up to
twice) with the approved brief and the conversation so far, holding the other
person's audio meanwhile, instead of hanging up. Gemini Live also resumes its
own session across the server's periodic GoAway. On OpenAI Realtime, a turn
that ends without a reply for four seconds gets one requested, so a lost
response never leaves the other person in silence. State shared across agent instances — check-in answers, hang-up
requests, the machine verdict — lives on the call session (`call_sessions` /
`callSessions`). The bridge or status webhook, whichever sees the call end
first, settles cost and wakes the task;
the sweep closes calls orphaned by a crash.

The bridge commits each note and owner check-in together with an opaque
provider-call receipt on the owner-scoped call session. Replayed note/check-in
callbacks reuse that effect; a reused provider identity with different content
fails closed. At 256 receipts, further note/check-in effects are refused rather
than evicting replay history. These receipts cover database notes and the
check-in's stable notification key; they do not certify a phone-key press or
call completion.
