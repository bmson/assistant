# Mobile interaction and save contract

An action should acknowledge the tap and update its local presentation within
200 ms. Network completion has no 200 ms guarantee. A first uncached read shows
a loading surface immediately; an already-loaded page stays available during
refresh. Native navigation keeps its standard transitions and gestures.

## Ordinary edits

`OptimisticEditStore` owns writes after a sheet closes. The model method returns
**accepted locally**, rather than **committed on the server**. The editor closes
on acceptance; the changed values appear immediately, and one app-wide status
shows Saving changes. When the write succeeds, reconciliation fetches the
relevant projections in the background. A failed follow-up read keeps the
acknowledged value and offers Refresh without repeating the write.

Server snapshots and patches are separate. Polling rebases under pending edits.
Writes run in order, and each patch is an idempotent assignment, removal, or
upsert. Reconciliation publishes its snapshots and removes confirmed overlays
in one main-actor turn. Reads begun before a newer edit cannot replace its
confirmed result. Pagination merges into server snapshots, never speculative
rows. Each observable cache publishes independently, so a Settings save does
not invalidate chat or People.

A failed write rolls back its patch without rolling back newer edits. The
app-wide changes panel retains the submitted wording and offers an explicit
retry for repeatable updates. New-item creation does not offer blind retry:
a transport error can mean the server created it and only the response was
lost. Local temporary IDs cannot be sent back as durable server IDs.

Before dispatch, an encrypted recovery journal records the submitted wording.
AES-GCM authenticates a server/owner-specific partition; its key stays in
Keychain. Protected files are excluded from backup. Confirmed writes leave the
journal immediately. After interruption, recovery asks the owner to check the
current information and copy the retained draft; requests are never replayed
automatically. Changing the connected account clears the old in-memory queue
and recovery journal. This is draft recovery, not an offline request-replay
service.

Memory erasure fences new memory edits and settles accepted writes before the
erasure request. A memory write with an unknown outcome requires review first. Once confirmed, it discards related failed drafts and clears
local memory projections so queued work cannot recreate erased content.

## Surface inventory

| Surface | Local feedback and read behavior |
| --- | --- |
| Assistant settings | Optimistic timezone, locale and signature; sheet closes on acceptance |
| Spending limits | Optimistic limits; sheet closes on acceptance |
| Skills | Optimistic creation, editing, deprecation and deletion |
| Goals | Optimistic creation, field edits, status/autonomy, archive and restore |
| People | Warm directory; optimistic creation, editing and deletion; cached profiles update together |
| Occasions | Optimistic creation, editing and deletion; profile and directory reconcile |
| Memory home | Optimistic corrections, creation, approval, rejection, forget and prominence |
| Memory library | Cached filter/page results; corrections and row actions update the shared cache |
| Writing voice | Cached editor load; optimistic save |
| Open loops | Cached list shared with editor; optimistic correction and row actions |
| Saved cards | Cached list; optimistic dismissal; source refresh remains a pending server operation |
| Documents | Cached overview; optimistic removal; uploads retain explicit in-flight feedback |
| Settings schedules, reminders, standing approvals | Optimistic enable/disable and removal |
| Default AI/voice models | Optimistic selection; cached provider list remains usable during refresh |
| AI-provider credentials, discovery and tests | Server-verified results; successful writes release before follow-up reload |
| MCP connections | Server-verified discovery and credential changes |
| Relationship map | Reuses the last loaded map immediately while refreshing; existing provisional layout and gesture rules retained |
| Knowledge corrections and merges | Ordered server confirmations retained for dependent writes and merge outcomes |
| Situation packs | Cached opening; revision-bound commands retain confirmed server outcomes |
| Calls | Cached list; call/check-in outcomes remain server-confirmed |
| Approvals | Existing optimistic inbox/message patches and rollback retained |
| Activity, work start/stop, improvements, repairs | Explicit pending action feedback; server outcomes remain authoritative |
| Chat, card forms, account pairing, privacy export/erasure | Existing admission/recovery and confirmation protocols retained |

Server-verified operations must display a pending state immediately. A provider
test, call hang-up, merge, or erasure must not be labelled completed merely
because the phone accepted the tap. Compound knowledge edits still stop at the
first failed dependent write and preserve their partial-success explanation.

Overview and workspace reads coalesce by connection and edit revision. Leaving
a page cancels that page's publication, while the shared request can still warm
the next page. Workspace and People prefetch begin after bootstrap without the
former artificial 1.5-second delay. Warm content remains editable if a refresh
fails; availability metadata and server-side validation still apply.

## Validation

`OptimisticEditsTests` covers delayed writes/reads, rollback onto newer snapshots,
ordered rapid edits, retry retention, ambiguous creates, connection changes,
atomic reconciliation, independent Observation, and encrypted owner-scoped
recovery. A 100-edit acceptance benchmark enforces the 200 ms budget.
`APIClientRetryTests` additionally covers actual settings PATCH acceptance,
rejection, stale reads, coalesced page loads, and navigation cancellation using
`URLProtocol` responses.

The October 18 macOS host run executed the same production outbox, model and
recovery sources with **14 tests passing**. Worst acceptance in 100 consecutive
edits was **0.199 ms** in that run. This measures model acceptance, not iPhone
frames, keyboard response, navigation animation, or time to first network data.
The iOS simulator build-for-testing passed. Simulator execution and native visual
checks were blocked while the Mac was locked; they must be completed before
claiming a fully verified release or app-wide device latency.
