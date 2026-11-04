# Performance, reliability, and UI responsiveness review

A review along three axes — how much work the server does per request, what
happens when one part of the system is slow, and what the client does between
frames. Findings were verified against the running code before anything was
changed; the fixes are in this commit, gated on `pnpm lint`, `pnpm typecheck`,
the full vitest suite against a real Postgres (1383 passing at time of
writing), and `pnpm build`.

The earlier [full review](codebase-review.md) covered performance once — bundle
size, Docker layer caching, two missing FK indexes, recall round trips — and
the three commits before this one fixed the chat client's render churn. This
pass deliberately looked where those did not: **unbounded reads**, **polling
cadence**, **work repeated per render**, and **the local queue driver that
self-hosters actually run**.

Twelve findings. Nine are fixed here; three are in the iOS client and are
recorded rather than applied, for the reason given in that section.

---

## Performance — server and data

### Fixed

**The task record was unbounded, in rows and in bytes.** `getTaskDetail`
selected _every_ tool call, model call, message, and file for a task with no
`LIMIT`, and the page rendered each one's full `args` and `result` through
`JSON.stringify(value, null, 2)` inside `<details>` — collapsed markup is still
in the RSC payload and still in the DOM. Tool results are persisted at whatever
size the tool returned: a fetched page, a workspace read, a browser step
budgeted to 400KB. A long-horizon mission therefore rendered megabytes on one
page load. This was the heaviest finding by a wide margin.

Two changes, because there were two problems. The timeline is now **paged from
the newest end** (100 entries, `?before=` walks back) — the four streams are
merged by taking the newest page of each, which is exactly the newest page
overall. And every recorded value is **serialized and clipped in the
application layer** into a `RecordedValue` (`text`, `truncated`, `totalChars`),
so the page prints what it was given and says plainly what it is not showing.
Page weight is now a function of the page size rather than of what the tools
happened to return.

`decision` is no longer shipped whole either — the page read two fields out of
it, so those two are extracted server-side.

> The "what actually happened" section reads the _whole_ task, not the visible
> page, so it would have been quietly broken by paging alone. It now has its
> own projection (`actions`) that carries every call with no `args` at all and
> a 600-character result preview. `completedSuccessfully` moved into the
> application layer with it: whether a provider actually did the thing is a
> rule about the work, not about how it is displayed, and the page had been
> deciding it.

**The pending-approvals query had no `LIMIT`** and selected whole `approvals`
rows — `payload` and `resolutionPayload` JSONB included — on a page that
auto-refreshes. Pending rows genuinely need their payload (edit-then-approve is
the point of the screen), so the bound went on the row count instead: 50. The
resolved list needed neither payload — it renders "· edited" — so it now
selects named columns and a boolean.

**Every chat read performed a write.** `getChatConversationView` stamped
`conversations.lastReadAt` unconditionally, and that path is the web page load,
`GET /api/mobile/v1/chats/[id]`, _and_ the mobile bootstrap. Every one of them
queued an `UPDATE` against the same row the executor writes `updated_at` to.
The stamp is now conditional on being more than 30 seconds stale — the unread
dot is about whether you have looked recently, not about the exact second.

**`archiveInactiveChats` was N+1** — up to 100 candidates, two queries each. It
is one `UPDATE … WHERE NOT EXISTS` now.

**The connection pool had no limits but `max`.** `createDb` was
`postgres(url, { max: 10, onnotice: () => {} })`: no idle timeout, so a
container held its whole pool open for its lifetime whether or not it was doing
anything; no connect timeout; and no statement timeout, so one pathological
query pinned a connection with nothing left to release it. All three are now
set, defaulted sanely, and configurable (`DB_POOL_MAX`,
`DB_IDLE_TIMEOUT_SECONDS`, `DB_CONNECT_TIMEOUT_SECONDS`,
`DB_STATEMENT_TIMEOUT_MS`) — the ceiling a database sees is per-process times
container count, and on Cloud Run that is up to 50 against defaults that are
often 25.

**`AutoRefresh` re-ran the entire route every 12 seconds.** `router.refresh()`
re-runs the page's queries _and_ the root layout's, so a tab left open on
Activity or Approvals was re-querying the database all day to render the same
screen. It now backs off geometrically to two minutes while the rendered output
is unchanged, and resets to 12 seconds the moment something differs or the tab
is refocused — so it costs nothing when work is actually arriving.

---

## UI responsiveness — web

### Fixed

**Every timestamp in the log was re-parsed on every render.** `messageDate()`
constructs a `Date` from an ISO string, and `orderChatLog` called it inside the
sort comparator — O(n log n) times per render, and during a stream that is once
per token. On a 100-message thread that is on the order of a thousand `Date`
constructions per token, all of them re-deriving an instant that cannot move.

Send times are now parsed once per id and carried in a `ChatLogOrder` alongside
the arrival map that was already there (the native client calls the same
concept `ChatLogOrder`, so the two now agree). Only _real_ timestamps are
cached: a message the client made itself has no send time yet and gets one when
its durable twin arrives under the same id, so caching its absence would pin it
after the log forever. That case is pinned by a test.

**Idle polls churned the log whenever a decision card was open.** The poll
sends `refresh=<ids>` for every unresolved approval, budget, or suggestion card
on screen, and the route returns those rows on _every_ tick. The merge counted
any arrival as a change, so a quiet thread holding one unanswered approval
handed React a new array — and re-parsed that card's markdown — every twelve
seconds to report that nothing had happened.

The merge now compares a re-read row against the one on screen and returns the
_same array reference_ when the tick moved nothing. It also moved out of the
effect closure into an exported `mergeChatLog`, which is what made it testable:
the repo's web tests use `renderToStaticMarkup` and there is no DOM test
infrastructure, so logic that matters has to be reachable without rendering.

### Looked at, deliberately left

**`latestTheme` ignores its argument and always returns `'default'`** — which
looks like dead code but is not: `chat-cues.test.ts` pins it, with a comment
recording that the owner asked for the mood colour to stay unchanged
permanently. Deleting it would delete an owner decision. The only removable
part was the `useMemo` wrapped around a now-constant-time call; the attribute
stays wired so the themes in `globals.css` can be switched back on in one
place.

---

## Reliability

### Fixed

**The local queue driver ran every task serially, and the maintenance sweep
behind them.** `startPoller` held one `busy` flag and `await`ed up to five due
tasks one at a time _in the same tick as the sweep_. One slow browser or code
step therefore blocked every other task — and blocked approval expiry, schedule
firing, and both re-notify passes — for its entire duration. In production
Cloud Tasks fans this out, but `docker compose up` is the README's quick start
and Compose sets `QUEUE_DRIVER=local`: for a self-hosted install this loop _is_
the queue, and a long task made the whole assistant look stalled.

Tasks now run three at a time, and the sweep has its own guard so maintenance
never queues behind execution. Concurrency is safe by construction — `claimTask`
is already an optimistic lock, so two runners racing for a row is a case the
machine handles.

> Writing the test found a real bug in the first version of this fix: capacity
> was computed before an `await`, so two overlapping drains each read `running`
> at zero and started a full batch. The reservation is taken synchronously now.

---

## Recorded, not applied

### iOS client

The three findings below are real and were verified by reading the code, but
they are **not fixed in this commit**. There is no Xcode in the environment
this review ran in, so a Swift change here could not be compiled, let alone
run — and shipping unverifiable edits to the native client is worse than
writing them down.

- **No optimistic updates on any mutation.** Every action in `AppModel.swift` —
  approve, deny, archive, retry, goal and memory edits — awaits the mutation and
  _then_ `refreshOverview()`, which is `/api/mobile/v1/overview`: four queries
  (50 activity items, goals, approvals, documents) whose result replaces the
  whole `overview` object. One tap costs two serial round trips before anything
  on screen moves. The fix is to apply the change locally first and reconcile
  after, and to have the mutation routes return the updated row so the second
  round trip is unnecessary at all.

- **The active chat poll runs at 650 ms** when there is no `taskId`
  (`AppModel.swift`), for up to 360 attempts, each one a full `getChatUpdates`.
  The web client does the same job at 2,500 ms. This is the native client's
  substitute for streaming, so the fast opening cadence is deliberate and worth
  keeping — but it should back off after the first several seconds rather than
  hold 1.5 requests per second for nine minutes.

- **The idle poll has no scene-phase gate.** `startIdlePolling()` loops every
  12 s with no `scenePhase` check, unlike the web hook's `visibilityState`
  guard. Background location is enabled, so the process can be resumed in the
  background and keep polling.

### Deployment

- **`assistant-web` deployed with `--min-instances 0`** (`infra/gcp/deploy.sh`).
  For an assistant opened a handful of times a day, that meant effectively every
  session paid a Next.js standalone cold start plus a fresh pool before the
  first byte. Compounding it, every Cloud Scheduler job targets `${AGENT_URL}`,
  so the _agent_ was kept permanently warm by the every-minute sweep while the
  web service — the only thing the iOS app and the browser talk to — was
  reliably cold.

  **Now fixed**, as part of tracking down "The request timed out" on app open:
  the web service deploys with `--min-instances 1`, and both services with
  `--cpu-boost`. This was the single largest contributor to "the app feels slow
  to open". It remains a cost decision — on the order of $10–25/month for the
  held instance — so the cheaper substitute, if that is ever unwanted, is a
  scheduler keepalive against `${WEB_URL}/api/health` (`make_job` hardcodes
  `${AGENT_URL}` today and would need a URL parameter).

---

## Verification

```sh
pnpm lint          # Biome + architecture boundaries — clean
pnpm typecheck     # 12 packages — clean
pnpm test          # 172 files, 1383 tests — all passing
pnpm build         # web + agent production builds — clean
```

New tests, each pinning a specific finding rather than the fix's shape:

| File                                              | Pins                                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/application/src/task-detail.test.ts`    | Timeline paging and `before`; large results clipped with the full size reported; the action summary still seeing every call while the timeline is paged |
| `apps/web/app/chat/[id]/use-chat-polling.test.ts` | A no-op re-read returning the _same array reference_; genuine changes still applied; retraction and streaming behaviour unchanged                       |
| `apps/web/app/chat/[id]/message-view.test.ts`     | A message sorted by the send time it gains later, not the one it lacked; order identical whether or not times are cached                                |
| `apps/agent/src/poller.test.ts`                   | Tasks running side by side; the concurrency budget holding under overlapping ticks; the sweep firing while a task is still running                      |
