# Generative UI

The assistant draws interfaces nobody designed ahead of time. It does this the
only way a shipped iOS app can: the model composes a **description** of a UI
out of a fixed vocabulary of native building blocks, and the app renders that
description with real SwiftUI. iOS cannot compile code at runtime and App
Review forbids downloading executable code, so "generate the SwiftUI" is not
an option at any layer; "generate the layout, render it natively" is what
every generative-UI system (A2UI, OpenAI widgets, MCP-UI) does. Novelty comes
from composition — a bigger vocabulary means more UIs the model can reach.

Mobile is the target. The web renders what it already knows and skips the rest.

## What exists

`packages/core/src/generative-card.ts` — the card compiler. A model picks
facts, a layout from the block vocabulary, an icon and actions. Every fact
value is checked verbatim against the evidence it was grounded in
(`validateGroundedCard`), and the result ships as a `generated-card` message
part that iOS draws in `MessageBubble.swift` and saves to the Cards tab.

The rules that make this safe, and that every layer below keeps:

- **Values are verbatim.** Anything a card states as fact appears word for
  word in the evidence, never sharpened out of a range.
- **The client computes, the model never does.** A countdown, a progress
  fraction or a chart scale is arithmetic done by trusted code over grounded
  values.
- **Actions are inert intents.** Nothing in the evidence reaches an action
  prompt; anything with a side effect goes through the approval policies.
- **Additive vocabulary.** Specs stay `version: 1` while changes are
  additive — a build that doesn't know a block renders nothing for it and
  keeps the rest of the card. Bumping the version would make older builds
  drop the whole card.

## Layers

### Layer 1 — layout and richer blocks

| Block       | Shape                                                         | For                                                |
| ----------- | ------------------------------------------------------------- | -------------------------------------------------- |
| `section`   | authored `title` + 1–6 leaf blocks                            | Grouping: Outbound / Return, Today / Tomorrow      |
| `metrics`   | 2–4 fact ids                                                  | Headline values side by side: Gate · Seat · Boards |
| `journey`   | `mode`, from/to facts, optional depart/arrive/status/duration | Flights, trains, drives between two places         |
| `progress`  | value fact, optional total and label                          | "76%", "3 of 5 stops" as a bar                     |
| `stages`    | 2–8 fact ids + current fact                                   | Package tracking, application pipelines            |
| `countdown` | ISO 8601 date fact with offset, optional label                | Departure, kickoff, deadline — ticks live          |
| `table`     | 2–4 authored column labels, rows of fact ids                  | Comparing hotels, flights, options                 |
| `chart`     | `bar`/`line`, 2–12 label/value points                         | Temperatures, spend, scores over time              |
| `checklist` | fact ids                                                      | Packing list, prep list; ticks are kept on device  |
| `map`       | 1–6 place facts (address or `lat, lng`)                       | Hotel, venue, a day plan; tap opens Maps           |

Sections nest one level only; a section holds leaf blocks. Shape problems a
model can make without lying (a chart value that isn't a number, a countdown
on a naive local time) drop that block; a grounding failure still refuses the
whole card.

### Layer 2 — live data (not planned)

Live cards need a live source. Scores already have one (the scoreboard
refreshes from ESPN). Flight status was built on FlightAware AeroAPI and
removed: no free source carries gates and delays, and the owner chose not
to add a paid service. A flight booking is still a card — the confirmation
as the airline wrote it, from mail or a pasted message — just not a live one.

### Cards from mail and messages

**Every kind of booking, from mail.** The google module observes inbound
mail for the things worth going back to — reservations, flights, tickets,
appointments, orders and deliveries. A prefilter (a booking word in
the subject, or printed as labelled fields; two kinds of detail such as a
date and a time; no sale language) gates the ordinary card
composer, whose verbatim check grounds every value in the email. Cards from
mail carry no links or images, since the sender is untrusted, and land on the
Cards page with one ambient notice; the same booking mailed again revises its
card quietly. In chat, a card whose every value is in the owner's own message
(a pasted confirmation) is grounded `message`: filed to the Cards page, with
the reply still above it.

### Design

Generated cards share one grid and type scale (`CardStyle`): blocks 20pt
apart, a block's parts 12, a label 4 above its value, equal columns across a
12pt gutter; an uppercase eyebrow for labels, body and value for facts, a
monospaced figure for anything read at a glance, and a display size for the
one thing a block is about. The journey reads like a boarding pass, statuses
take the colour of what they mean, a countdown does not repeat a clock the
journey already shows, figures in a table align right, and actions share one
row of equal tiles (a single action is a plain button).

### Layer 3 — inputs (deferred)

Not built. The composer rewrites every model-authored `ask_assistant` prompt
to a fixed string, because a prompt lifted from evidence would reach the
owner's own turn. A form would need the same care: fields that prefill the
composer for the owner to read and send, never a submit that speaks for
them. Worth doing when a real flow asks for it.

### Layer 4 — device actions

**Built.** `add_to_calendar` (`startFact`, optional `endFact` and
`locationFact`, all zoned instants) opens the system event sheet prefilled;
nothing is written unless the owner taps Add, and the sheet needs no calendar
permission. `directions` opens Apple Maps to a place fact. Every generated
card has a share button that sends its title and non-sensitive facts as text.
An action the phone could not perform — a calendar entry on a wall-clock
time, directions to a sensitive fact — is dropped and the card kept.

### Layer 5 — learning loop

Log request → evidence → spec → what the owner did with it (expanded, tapped,
dismissed, refreshed). Use it as an eval set in the question-regression
harness and for prompt tuning. Optionally distil into a Foundation Models
adapter so simple cards compose on device; adapters are pinned to a base-model
version and must be retrained per OS release, so this stays an optimisation.
