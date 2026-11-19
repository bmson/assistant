# Optional personal Calendar event creation

This is the first Phase 2 source slice. It is **off on the current release contract**. Source tests do not establish provider consent, provider behavior, deployment, or installed-iPhone acceptance. Personal move/update/cancel actions are not included. Assistant-account tools, `BOT_GOOGLE_REFRESH_TOKEN`, and phone-calendar sharing keep their existing authority.

## Connection API

The existing authenticated mobile endpoints remain in use:

- `GET /api/mobile/v1/connections/google-calendar` adds `connectionId`. `capabilities.calendarRead` remains independent. `capabilities.calendarWrite` is omitted if this runtime cannot offer writes, `false` if a write upgrade is available but not granted, and `true` only for an enabled, connected write grant.
- `POST /api/mobile/v1/connections/google-calendar/connect` accepts `{}` for the existing read flow or `{ "capability": "calendarWrite" }` for an explicit upgrade of an existing working read connection. Callers cannot supply arbitrary scopes, identities, or callback destinations.
- Authorization URL, flow ID, expiry, callback, flow polling, and flow cancellation retain their existing shapes. A callback redirect is not success. Read canonical status after the flow and require `calendarWrite: true` before showing event-write access as enabled.

The upgrade requests `calendar.events` alongside the existing read and identity scopes, without importing unrelated grants through `include_granted_scopes`. The verified Google subject must match the current personal account. The upgrade intent and expected connection identity are bound inside authenticated OAuth state; the stored strict flow object keeps its original fields. Denial, cancellation, expiry, partial scope, wrong identity, missing offline credentials and probe failure preserve the existing read credential. Successful upgrades retain the connection ID, advance the credential fence, and reject completion of an older refresh. Refresh scope loss can disable writes while retaining usable reads.

## Approval and operation recovery

Use the established `calendar.create_event` tool with explicit `account: personal` and `calendarId` from the personal roster. The default remains assistant-account creation for existing callers. Personal creation always requires a fresh action approval, including events without attendees; standing allow rules and free-range grants do not bypass it.

Before approval, the server resolves the destination to a stable calendar ID and checks write access. The sealed approval binds owner, task, connection generation, provider subject/email, destination calendar, fixed provider event ID and all event details. Editing the approved account, destination or event details requires a fresh approval. The existing mail-booking currentness guard also applies immediately before creation. Each personal provider request rechecks the current connection and capability. Personal failures never select assistant credentials. Other mutation tools reject an explicit personal selector until their later slice is implemented.

The existing durable tool-call claim allows one executor. Before the POST, the existing external-effect checkpoint records the fixed event ID at `prepared`; later stages are `created` and `verified`. Google receives that UUID-derived ID and a private operation/payload marker. Success requires a canonical GET of that same ID matching approved details, attendees, marker and an owner-usable Google event link. This is not a claim that attendees accepted or that invitation emails were delivered.

An ambiguous POST, fixed-ID conflict, or lost/interrupted readback never causes another POST. Readback either confirms the same operation or retains an uncertain receipt with retries suppressed. `calendar.reconcile_event_creation` accepts the original `taskId` and `toolCallId`, loads that owner's approved/checkpointed call, rechecks the same connection and sealed details, and performs only a GET. Missing or changed results remain uncertain. Existing receipts continue fencing execution after restart; reconciliation records its own result without rewriting the historical uncertain outcome.

## Compatibility and activation prerequisite

A successful write grant advances the durable connection record to **version 2**. The new parser accepts version-1 read connections and version-2 connections, and refuses write credentials mislabeled as version 1. Disabling writes on the new runtime keeps version-2 credentials readable and does not delete or downcast them. Cancelled/failed upgrades preserve version-1 read records and the original flow format.

The prior deployed binary is **not compatible with upgraded state**: its strict version-1 parser and read-only scope validator cannot read a version-2 write connection. The unchanged SQL table shape does not make this backward-compatible. Original read clients remain supported; rollback of the server binary is a separate boundary.

`googleCalendarWriteContractReady` therefore requires exact API contract 2, all declared peer ranges 2–2, and exact storage contract 2–2/version 2 for Firestore or 137–137/version 137 for PostgreSQL. Missing, old, partial or conflicting metadata leaves the write upgrade and personal provider writes disabled. This source change does not alter release contracts, apply a migration, or activate either storage version.

Before activation, the release owner must qualify the corresponding agent/web/worker compatibility, storage contract and deployment/migration path, including pending operation retention. All runtimes that can consume these records must support the new contract. Rollback after a write grant must use a compatible implementation; a direct rollback to the old read-only binary is not qualified. Do not enable this by hand-editing release metadata or erase/downcast credentials to bypass the boundary. Real consent, same-operation provider outcomes, process restart and installed-iPhone acceptance need separately authorized evidence.

## Provider references

- [Google OAuth scopes and incremental authorization](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Calendar event insertion and caller-supplied IDs](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
- [Read an event by its canonical Calendar event ID](https://developers.google.com/workspace/calendar/api/v3/reference/events/get)

Google documents that event ID collisions are not guaranteed to be detected at creation time. The implementation uses a UUID-derived ID, durable single-executor claims and readback; it does not treat an ID alone as an exactly-once guarantee or issue blind retry POSTs.
