# AI Assistant Implementation Playbook — implementation register

> Historical baseline: this register preserves the October 7–8 implementation review. Its item statuses and test counts are dated evidence, not current production acceptance. Current release and behavior claims require fresh source-bound CI, deployment and acceptance receipts.

Updated 2026-10-08. Review baseline: `ce348d48ef0a9629907873e79c0c97a9ed891f11`.

This register accounts for all seven supplied attachments: 246 canonical findings, 25 execution packets, 56 acceptance journeys and 15 merged aliases. The detailed source text, exact conditions, acceptance criteria, workbook mappings and original binary digests are retained locally in `.workspace/playbook-review/manifest.json`, `requirements.json` and `findings.json`. Original attachments were not changed. These private review materials are ignored by Git.

The attachments describe defects, conditional concerns, proposals and a withdrawn candidate. They are evidence and requirements to evaluate, not instructions authorizing cloud changes or destructive actions. APP-02 remains withdrawn; Firestore Shortcut location is intentionally unsupported. Optional web findings remain applicable before optional web reactivation.

## Status rules

- **Implemented and locally verified**: the stated narrow change has its local regression evidence. This is not a deployed acceptance claim.
- **Partial**: source changes exist, but one or more documented acceptance conditions remain open.
- **In progress**: an implementation wave is active; it is not accepted.
- **Open**: not implemented or not established in this work. A design proposal is explicitly marked.

No row is closed merely because its packet was reviewed. Database fixtures use an allocator-owned temporary loopback PostgreSQL database. Firestore emulator tests run locally alongside disposable PostgreSQL fixtures; the final repaired-state qualification is reported below. Native test execution and physical-device/cloud acceptance have not been certified.

## Implemented work and limits

Changes cover answer preservation and URL grounding, bounded calendar/lookup evidence, sensitive cards, cancellation receipts, request history boundaries, approval authority/expiry, provider deadlines and fallback, private location access, collaborative Google edits, path restrictions, receipt retention, privacy fences and import provenance, native interactions, owner-scoped API mutations, disposable verification, setup and cutover recovery. The workstream reports under `.workspace/playbook-review/*-status.md` describe exact scope and remaining conditions.

The full typed request/response/evidence contracts, durable delivery and scheduler protocols, comprehensive provider revocation, worker isolation, historical upgrades, live cutover/restore, knowledge/context proposals and all 56 end-to-end journeys remain subject to their per-finding acceptance criteria.

## Direct owner UI requirement

The owner added simple, clean, minimal UI/UX with careful typography, grid alignment and iconography as a core acceptance criterion on October 7. The shared standard is in [design-system.md](../design-system.md). Current web/native polish reports distinguish actual browser evidence, native compilation, historical captures and unavailable physical/simulator checks. This direct user requirement supplements the source documents without changing their original 246 finding identities.

## Canonical findings

| ID | Finding | Status | Packet |
| --- | --- | --- | --- |
| APP-11 | Local Gmail polling bypasses the migration activation fence | Implemented and locally verified | P19 |
| AUX-API-PARSING | Real-auth, bounded-body and per-section API tests must run beyond mocks | Partial; source changes and focused checks | P00 |
| AUX-MIGRATIONS | Upgrade, ownership, transform and recovery requirements span migration prefixes | Partial; source changes and focused checks | P19 |
| AUX-SINGLE-OWNER | Enforce one-owner installation or explicitly migrate global identities before multitenancy | Partial; source changes and focused checks | P04 |
| AUX-TOOLS-ISOLATION | Worker cancellation, process-tree lifetime and local byte/path limits need adversarial validation | Partial; source changes and focused checks | P18 |
| CC-01 | Updating or rolling back applies a foundation-only configuration to the live runtime state | Partial; source changes and focused checks | P20 |
| CC-02 | Ready can be satisfied by an old or unrelated model call rather than a current owner response | Partial; source changes and focused checks | P20 |
| CC-03 | A crash between a cutover mutation and its evidence write defeats rollback’s attempted-step detection | Partial; source changes and focused checks | P20 |
| CC-04 | Rollback is not bound to the configuration and evidence chain that authorized the cutover | Partial; source changes and focused checks | P20 |
| CC-05 | Retirement can report READY after a rollback, including with a fresh inventory | Partial; source changes and focused checks | P20 |
| DM-01 | A journal timestamp inversion can skip the approval-policy uniqueness migration | Implemented and locally verified | P19 |
| DM-04 | The consumer pilot requires a browser chat that route policy forbids | Partial; source changes and focused checks | P19 |
| DM-05 | Living guidance contradicts current driver, module, queue and release behavior | Partial; source changes and focused checks | P19 |
| DM-06 | The PostgreSQL restore drill starts a temporary runtime without fencing restored work | Partial; source changes and focused checks | P19 |
| FS-15 | Valid migration documents can form an oversized transaction that cannot resume | Partial; source changes and focused checks | P19 |
| IOS-13 | Native review export does not bind build/runtime provenance to the actual test run | Partial; source changes and focused checks | P00 |
| IOS-14 | Shipping guide contradicts APNs implementation and portrait shipping contract | Partial; source changes and focused checks | P20 |
| OPS-01 | Code job does not enforce its advertised network isolation | Partial; source changes and focused checks | P18 |
| OPS-02 | Current-only cleanup destroys project-wide secret history using a regional dependency inventory | Partial; source changes and focused checks | P20 |
| OPS-03 | Self-repair's trusted guard permits Firestore owner-authentication code | Partial; source changes and focused checks | P18 |
| OPS-04 | Consumer private-agent Cloud Tasks/Scheduler audiences conflict with Cloud Run IAM | Partial; source changes and focused checks | P19 |
| OPS-05 | The generated local .env is rejected by its own schema | Implemented and locally verified | P19 |
| OPS-06 | Fresh legacy GCP provisioning cannot bootstrap its required agent URL | Partial; source changes and focused checks | P19 |
| OPS-07 | Shipping agent dependencies differ from tested/audited lock and escape image JS scanning | Partial; source changes and focused checks | P20 |
| OPS-08 | Consumer Google-auth native token provisioning is incompatible with read/rotation code | Partial; source changes and focused checks | P19 |
| OPS-09 | Live goal verification can run unrelated due schedules and removes real cost evidence | Implemented and locally verified | P00 |
| OPS-10 | Private Markdown voice samples are falsely described as gitignored | Implemented and locally verified | P20 |
| OPS-11 | Independent service rollout leaves incompatible versions live after a failed agent release | Partial; source changes and focused checks | P20 |
| OPS-12 | Manual/local release paths do not perform the advertised source verification | Partial; source changes and focused checks | P20 |
| OPS-14 | Demo people purge deletes the real owner's graph relations | Partial; source changes and focused checks | P00 |
| OPS-15 | Phone setup corrupts minimal module selection after changing Twilio state | Partial; source changes and focused checks | P19 |
| OPS-16 | Several older visual utilities write authoritative fixture conversations into the ordinary owner database | Partial; source changes and focused checks | P00 |
| OPS-17 | Selective screenshot recapture can relabel stale evidence as current CSS evidence | Implemented and locally verified | P00 |
| R2 | Integration tests can destroy or corrupt unrelated data | Partial; source changes and focused checks | P00 |
| TW-18 | Deployed code-worker permissions cannot stage its declared inputs | Partial; source changes and focused checks | P18 |
| API-01 | Anonymous invalid bearer tokens bypass the secret-read cache | Partial; source changes and focused checks | P04 |
| API-02 | Same-site cross-origin requests can use owner cookies on mobile mutations | Partial; source changes and focused checks | P04 |
| API-03 | PostgreSQL object mutations do not consistently enforce the owner checked on reads | Partial; source changes and focused checks | P04 |
| API-06 | Successful task-control responses do not identify what actually changed | Partial; source changes and focused checks | P07 |
| API-10 | Goal target-date validation permits normalized nonexistent dates | Partial; source changes and focused checks | P03 |
| APP-12 | A failed prior document attempt suppresses a fresh explicit read | Partial; source changes and focused checks | P03 |
| CF-05 | Chat admission has no stable retry identity | Partial; source changes and focused checks | P02 |
| CF-08 | An owner request can be mislabeled as an external request | Partial; source changes and focused checks | P04 |
| FS-01 | Approval chat hydration loses the tool name | Partial; source changes and focused checks | P04 |
| HC-03 | Task identity and latest intent are not a coherent runtime boundary | Partial; source changes and focused checks | P02 |
| HC-05 | Clarification can finish before the sources that would answer it are loaded | Partial; source changes and focused checks | P03 |
| HC-07 | Later owner changes suppress recovery but not obsolete completion requirements | Partial; source changes and focused checks | P03 |
| HC-11 | Ordinary physical-card text can be promoted to an explicit UI-card obligation | Partial; source changes and focused checks | P03 |
| HC-12 | Planner mistakes tainted third-party content for positive owner intent | Partial; source changes and focused checks | P04 |
| MC-03 | Localized/unknown quoted owner email bypasses direct-email taint | Partial; source changes and focused checks | P04 |
| MC-04 | Card observer executes before unauthenticated direct email is rejected | Partial; source changes and focused checks | P04 |
| MC-05 | Explicit Gmail sync disable is ignored by Pub/Sub ingress | Partial; source changes and focused checks | P04 |
| PG-02 | Approval expiry is not enforced at decision time | Partial; source changes and focused checks | P04 |
| R12 | Calendar directions ignore the day the owner requested | Implemented and locally verified | P03 |
| R7 | Direct Google Doc routing ignores an explicit prohibition on reading | Partial; source changes and focused checks | P03 |
| R9 | Historical calendar questions are forced into future date windows | Implemented and locally verified | P03 |
| TW-02 | A failed MCP preparation can remove the mandatory approval binding | Partial; source changes and focused checks | P04 |
| TW-03 | Delayed approved execution does not revalidate current prohibitions | Partial; source changes and focused checks | P04 |
| TW-07 | Public weather/maps capabilities expose the private owner-location fallback to external tasks | Partial; source changes and focused checks | P04 |
| TW-08 | Investigating audit evidence can make the offered repair-report approval ineffective | Partial; source changes and focused checks | P04 |
| TW-11 | File-prefix allowlists run before path normalization | Partial; source changes and focused checks | P04 |
| TW-12 | Raw Gmail labels bypass the archive approval tier | Partial; source changes and focused checks | P04 |
| TW-13 | Collaborative Google edits are incorrectly treated as private-only writes | Partial; source changes and focused checks | P04 |
| APP-03 | Chat cursor's full-page shortcut defeats late-commit protection | Partial; source changes and focused checks | P02 |
| APP-05 | Approval email overclaims that nothing has happened | Partial; source changes and focused checks | P07 |
| APP-06 | Task audit timestamp pagination can permanently omit equal-time events | Partial; source changes and focused checks | P02 |
| APP-09 | Production notification fanout can stamp total delivery failure as success | Partial; source changes and focused checks | P06 |
| AUX-CONTRACT-SHAPES | Checkpoint shapes, money/time validators and import link constraints need real contract round-trips | Implemented and locally verified | P05 |
| AUX-TOOLS-IDENTITY | Gmail/artifact keys conflate operation identity with title or nondeterministic content | Partial; source changes and focused checks | P05 |
| CF-01 | Mission session instruction loss and recursive creation | Partial; source changes and focused checks | P07 |
| CF-02 | The repeated confirmation is deterministic product copy | Partial; source changes and focused checks | P07 |
| CF-03 | Reminder cards show superseded creations as active | Partial; source changes and focused checks | P07 |
| CF-04 | Reminder creation is not retry-idempotent | Partial; source changes and focused checks | P05 |
| CF-06 | “After the game tomorrow” has no enforced temporal dependency | Partial; source changes and focused checks | P07 |
| CF-07 | Mission cadence is dropped, and recursive roots escape the original mission budget | Partial; source changes and focused checks | P07 |
| DM-03 | Retiring the default morning brief also disables owner-customized schedules | Partial; source changes and focused checks | P07 |
| FS-13 | A late/replayed callback can revive a timed-out job or overwrite an already-recorded result | Partial; source changes and focused checks | P05 |
| HC-01 | Native Stop stops observation, not execution | Partial; source changes and focused checks | P01 |
| HC-02 | Native poll failure/timeout can say “Your result is ready” | Partial; source changes and focused checks | P01 |
| HC-04 | Correct silence from proactive work becomes an error | Partial; source changes and focused checks | P07 |
| HC-08 | Future-notification request becomes a read-only answer, then an honest dead end | Partial; source changes and focused checks | P07 |
| MC-01 | A placed call's selected voice route is not frozen for media connection | Partial; source changes and focused checks | P22 |
| MC-02 | Terminal call status commits before durable result delivery, preventing retry | Partial; source changes and focused checks | P22 |
| MC-10 | A skipped channel send is treated as a completed delivery attempt | Partial; source changes and focused checks | P06 |
| MC-12 | Outbound call concurrency/day limits are check-then-create | Partial; source changes and focused checks | P22 |
| PG-01 | Cancelling a watch can be undone by an in-flight fire | Partial; source changes and focused checks | P07 |
| PG-03 | Primary-chat fallback can adopt the assistant-only Notifications thread | Partial; source changes and focused checks | P06 |
| PG-06 | First concurrent SMS messages can split into a conversation with no return route | Partial; source changes and focused checks | P06 |
| PG-08 | Self-repair claiming can overwrite an owner dismissal | Partial; source changes and focused checks | P07 |
| PG-09 | Microsecond reply cursors can repeatedly re-inject prior owner messages on resume | Partial; source changes and focused checks | P02 |
| R1 | Multi-call suspension loses earlier approvals and leaves an invalid transcript | Partial; source changes and focused checks | P05 |
| R10 | Compound SMS sends remain incomplete after real successful sends | Partial; source changes and focused checks | P07 |
| R13 | Calendar projections can merge distinct recurring occurrences and hide real conflicts | Partial; source changes and focused checks | P07 |
| R14 | Watch suggestion recovery depends on the model repeating its earlier decision | Partial; source changes and focused checks | P06 |
| R3 | Mission outcomes and alerts lack durable report delivery intent | Partial; source changes and focused checks | P06 |
| R4 | Stalled-goal replacement can cancel a newly resumed task | Partial; source changes and focused checks | P07 |
| R5 | Invalid autonomy expiration fails open | Partial; source changes and focused checks | P04 |
| R6 | Retention can erase live task execution evidence | Partial; source changes and focused checks | P05 |
| R8 | Checklist cannot represent owner-cancelled outcomes | Partial; source changes and focused checks | P07 |
| TW-04 | Repeated jobs reuse earlier artifact identities | Partial; source changes and focused checks | P05 |
| VH-04 | Call transcript flushing can discard unpersisted batches | Partial; source changes and focused checks | P22 |
| FS-14 | Asynchronous learned-memory and voice writers can cross successful privacy erasure | Partial; source changes and focused checks | P08 |
| HM03 | Document erasure acknowledges success after losing retryable blob work | Partial; source changes and focused checks | P08 |
| HM05 | Import deletion does not erase derived archive content or occasions | Partial; source changes and focused checks | P08 |
| HM06 | Untrusted occasion updates inherit an already-trusted row | Partial; source changes and focused checks | P08 |
| HM21 | Transient location is copied into durable task instructions | Partial; source changes and focused checks | P08 |
| PG-05 | Privacy erasure can lose to an in-flight card compilation or memory save | Partial; source changes and focused checks | P08 |
| APP-07 | Relationship correction is split, and the old fact remains recallable | Partial; source changes and focused checks | P10 |
| AUX-AUDIT-PRIVACY | Audit redaction is not anonymization and needs URL/field-aware handling | Partial; source changes and focused checks | P08 |
| DM-07 | Audit capture is described as never reused in prompts although tools expose it to the assistant | Partial; source changes and focused checks | P08 |
| FS-05 | Prior-conversation evidence window is not actually the newest tool receipts | Partial; source changes and focused checks | P09 |
| FS-07 | Message embedding cursor permanently skips backfilled history and embedding-space changes | Partial; source changes and focused checks | P09 |
| FS-08 | Commitment history eventually disables extraction for an otherwise valid recurring fact | Partial; source changes and focused checks | P09 |
| FS-10 | Editing an occasion's date breaks the deterministic identity used by other writers | Partial; source changes and focused checks | P10 |
| FS-11 | Deleting an auto-created person leaves a stale name identity that future learning trusts | Partial; source changes and focused checks | P10 |
| FS-16 | Entity merge deletes an owner's rejection in favor of an unreviewed duplicate | Partial; source changes and focused checks | P10 |
| FS-17 | Knowledge workspace reports relations as in recall when runtime necessarily rejects them | Partial; source changes and focused checks | P10 |
| HM04 | Processor completion has a crash gap, and the last allowed live attempt can be retired early | Partial; source changes and focused checks | P09 |
| HM07 | Consolidation can turn dated historical facts into current timeless facts | Partial; source changes and focused checks | P10 |
| HM08 | Graph date normalization instructions conflict with literal grounding | Partial; source changes and focused checks | P10 |
| HM09 | Predicate canonicalization erases past tense and grounding does not establish direction or negation | Partial; source changes and focused checks | P10 |
| HM14 | Portable consolidation can retire every member of a fact cycle | Partial; source changes and focused checks | P10 |
| HM15 | Voice archive ingestion can attribute third-party writing to the owner | Partial; source changes and focused checks | P09 |
| HM16 | Archive parsing silently loses content and substitutes a window's median date for individual evidence | Partial; source changes and focused checks | P09 |
| HM17 | Segment watermarks skip unresolved messages and can hide more relevant raw evidence | Partial; source changes and focused checks | P09 |
| HM18 | SQL skill reflection can overwrite an owner edit made during model/embedding work | Partial; source changes and focused checks | P10 |
| HM20 | All-day event display shifts dates in UTC+12 and later zones | Partial; source changes and focused checks | P13 |
| HM22 | Large documents can be marked fully ready after indexing only a prefix | Partial; source changes and focused checks | P09 |
| MC-11 | Forwarded ingestion loses the pipeline after a message-only crash checkpoint | Partial; source changes and focused checks | P09 |
| ME-01 | One oversized contact poisons the whole job after paid work | Partial; source changes and focused checks | P09 |
| ME-02 | Deterministic persistence errors regenerate and re-embed up to eight times | Partial; source changes and focused checks | P09 |
| ME-03 | Unvalidated person creation feeds a polluted authoritative-looking catalog | Partial; source changes and focused checks | P10 |
| ME-04 | Prefix matching can steal an exact identity or collapse distinct people | Partial; source changes and focused checks | P10 |
| ME-05 | A discarded duplicate fact can still create a contact | Partial; source changes and focused checks | P09 |
| ME-06 | Occasion-only output is silently discarded and checkpointed | Partial; source changes and focused checks | P09 |
| DESIGN-KNOWLEDGE | Canonical assertions, inverse presentation, grouped curation and explained derivations | Partial; source changes and focused checks | P10 |
| DESIGN-CONTEXT | Decision-aware context selection and relevance before planning | Partial; source changes and focused checks | P11 |
| DESIGN-CONTEXT-UX | Selective use, conflict handling and useful contextual initiative | Partial; source changes and focused checks | P11 |
| FS-12 | Every new Firestore watch suggestion has an ID the native decision route rejects | Partial; source changes and focused checks | P12 |
| HC-09 | Proactive “Still open” is not proof the owner still owes an action | Partial; source changes and focused checks | P12 |
| HM01 | Closing a commitment does not fence replay of the same source occurrence | Partial; source changes and focused checks | P12 |
| HM02 | Time-based cleanup can discard future promises and the reminder just snoozed | Partial; source changes and focused checks | P12 |
| HM10 | Calendar window disappearance is asserted as cancellation | Partial; source changes and focused checks | P12 |
| HM11 | Candidate limits and snooze state can suppress valid due reminders | Partial; source changes and focused checks | P12 |
| HM23 | Curiosity claims a question forever before durably posting it | Partial; source changes and focused checks | P12 |
| MC-13 | Watch dedupe commits before notifications/suggestion enqueue | Partial; source changes and focused checks | P12 |
| MC-14 | Web watch dedupe suppresses a genuine later repeated transition | Partial; source changes and focused checks | P12 |
| PS-01 | Calendar conflict evidence and identity | Partial; source changes and focused checks | P12 |
| PS-02 | Cancellation, supersession, and stale suggestions | Partial; source changes and focused checks | P12 |
| PS-03 | Duplicate security alerts and cross-surface repetition | Partial; source changes and focused checks | P12 |
| PS-04 | Ranking, context, and dismissed-card accumulation | Partial; source changes and focused checks | P12 |
| PS-05 | Berlin spa timezone | Partial; source changes and focused checks | P12 |
| MC-06 | Embedding calls ignore disabled model rows | Partial; source changes and focused checks | P14 |
| MC-07 | Connection revocation has stale/fail-open windows | Partial; source changes and focused checks | P04 |
| API-04 | Card-image response cap is enforced after allocation | Partial; source changes and focused checks | P13 |
| API-05 | Card-image DNS preflight is not bound to the actual connection | Partial; source changes and focused checks | P13 |
| API-09 | One workspace section failure blocks unrelated native screens | Partial; source changes and focused checks | P13 |
| APP-01 | Firestore composition drops configured heavy-document processor | Partial; source changes and focused checks | P09 |
| APP-04 | Local PostgreSQL sweep still aborts maintenance after owner-read failure | Partial; source changes and focused checks | P13 |
| AUX-MAPS-SPORTS | Sports/maps must preserve coverage, historical scope, transport mode and trusted image hosts | Partial; source changes and focused checks | P13 |
| AUX-TOOLS-MCP | MCP stream matching and ambiguous effects need an explicit transport contract | Partial; source changes and focused checks | P13 |
| AUX-TOOLS-READS | Source reads need loss, structure, pagination and completeness receipts | Partial; source changes and focused checks | P13 |
| FS-04 | Gmail's expiring lock does not fence the worker it replaces | Partial; source changes and focused checks | P09 |
| FS-18 | Lifetime-history bounds make owner cleanup and live views fail on ordinary growth | Partial; source changes and focused checks | P09 |
| FS-19 | Supported large documents become unreadable in the owner detail view | Partial; source changes and focused checks | P09 |
| HC-06 | Mail lookup coverage conflates found hits with inspected answer evidence | Partial; source changes and focused checks | P11 |
| MC-08 | Supported embedding dimensions are rejected by the common router | Partial; source changes and focused checks | P14 |
| MC-09 | SMS budgets count one unit regardless of multipart encoding | Partial; source changes and focused checks | P15 |
| MC-15 | Email attachment path collisions overwrite or delete referenced bytes | Partial; source changes and focused checks | P09 |
| PROV-01 | Recoverable investigation failures become terminal | Partial; source changes and focused checks | P14 |
| PROV-02 | Router and repair triage both own fallback, masking the recovery cause | Partial; source changes and focused checks | P14 |
| PROV-03 | Capability metadata does not validate the actual request shape | Partial; source changes and focused checks | P14 |
| PROV-04 | Raw, misleading, non-actionable repair notices | Partial; source changes and focused checks | P14 |
| PROV-05 | Error classification traversal is artificially shallow | Partial; source changes and focused checks | P14 |
| R11 | Grounding validates a bag of facts rather than the relationships the answer claims | Partial; source changes and focused checks | P11 |
| R15 | Complete calendar answers silently drop rows and all-day dates can shift | Partial; source changes and focused checks | P13 |
| R16 | URL provenance treats distinct resource addresses as equivalent | Partial; source changes and focused checks | P11 |
| TW-01 | Code callback limits exceed the receiving webhook limit | Partial; source changes and focused checks | P13 |
| TW-05 | Spreadsheet/PPTX extraction drops structural meaning | Partial; source changes and focused checks | P09 |
| TW-10 | Provider deadlines stop short of complete response consumption | Partial; source changes and focused checks | P13 |
| TW-14 | Calendar coverage can be reported complete after dropping requested calendars | Partial; source changes and focused checks | P13 |
| TW-15 | Calendar attendee updates lose fields and can target the wrong shared-calendar identity | Partial; source changes and focused checks | P13 |
| TW-16 | Slides “append” prepends new slides | Partial; source changes and focused checks | P13 |
| TW-17 | Drive ingestion and attachment staging reuse mutable filenames | Partial; source changes and focused checks | P09 |
| TW-19 | Native Google Sheets reading/ingestion silently exports only the first worksheet | Partial; source changes and focused checks | P09 |
| VH-03 | Call interruption accounting estimates playback without transport acknowledgments | Partial; source changes and focused checks | P22 |
| APP-02 | Withdrawn candidate: Firestore Shortcut location is intentionally unsupported | Withdrawn; intentionally unsupported | P21 |
| HM12 | Deterministic hotel cards copy secret-bearing mail into an unmasked fact | Partial; source changes and focused checks | P08 |
| IOS-01 | Transcription failure bypasses microphone teardown | Partial; source changes and focused checks | P01 |
| IOS-03 | Undo-hide can publish stale conversation across navigation/account changes | Partial; source changes and focused checks | P16 |
| IOS-06 | Foreground location opt-out is not rechecked before transmission | Partial; source changes and focused checks | P01 |
| IOS-09 | Latched composer dictation has no background stop | Partial; source changes and focused checks | P01 |
| IOS-10 | Automatic speech bypasses approval privacy projection | Partial; source changes and focused checks | P01 |
| IOS-11 | Generated-card sensitivity is not enforced on secondary fields or accessible speech labels | Partial; source changes and focused checks | P08 |
| API-08 | Coalescing can return a pre-mutation snapshot to a post-mutation refresh | Partial; source changes and focused checks | P16 |
| DESIGN-COMPOSITION | Bounded native component composition with server-owned actions | Partial; source changes and focused checks | P17 |
| FS-06 | Fresh goal work chats are missing from ordinary chat lists | Partial; source changes and focused checks | P16 |
| HM19 | Nested card validation discards its own sanitized result | Partial; source changes and focused checks | P17 |
| IOS-02 | Push registration dedupe has no server or owner scope | Partial; source changes and focused checks | P16 |
| IOS-04 | Notification inline decisions skip notification-owner check | Partial; source changes and focused checks | P16 |
| IOS-05 | Late speech cancellation can clear replacement speech | Partial; source changes and focused checks | P16 |
| IOS-12 | Generated map refresh keys ignore changed place values | Partial; source changes and focused checks | P16 |
| IOS-15 | Talk ignores failure to enable echo cancellation | Partial; source changes and focused checks | P16 |
| IOS-16 | Scoreboard logo allowlist accepts lookalike external hosts | Partial; source changes and focused checks | P16 |
| IOS-17 | Future scoreboards have no clock-driven transition into live polling | Partial; source changes and focused checks | P16 |
| IOS-18 | Unbounded card numbers reach trapping integer conversions | Partial; source changes and focused checks | P16 |
| IOS-19 | Duplicate knowledge-card node IDs trap during parsing | Partial; source changes and focused checks | P16 |
| IOS-20 | Partial availability can be presented as unqualified “Free” | Partial; source changes and focused checks | P16 |
| IOS-22 | Graph VoiceOver reverses directed relationships at the object endpoint | Partial; source changes and focused checks | P16 |
| IOS-23 | Import size limits are enforced only after a full synchronous file read | Partial; source changes and focused checks | P16 |
| IOS-24 | Knowledge item save can merge after rename/retype failed | Partial; source changes and focused checks | P16 |
| WEB-01 | Local mobile-key rotation weakens .env file permissions | Partial; source changes and focused checks | P21 |
| WEB-02 | Administration lost a discoverable per-browser sign-out | Implemented and locally verified | P21 |
| WEB-03 | Retained provider form carries a credential across provider destinations | Partial; source changes and focused checks | P21 |
| WEB-04 | Retained KG date correction submits the old date identity | Partial; source changes and focused checks | P21 |
| WEB-05 | Retained editors let “Cancel” dismiss an already-submitted mutation | Partial; source changes and focused checks | P21 |
| WEB-06 | Retained live-call controls can hide a second question | Partial; source changes and focused checks | P21 |
| WEB-07 | Revealed sensitive values remain inaccessible through the control's accessible name | Partial; source changes and focused checks | P21 |
| WEB-08 | Dormant cap form rejects values accepted and persisted by the API | Partial; source changes and focused checks | P21 |
| WEB-09 | Uncontrolled action forms can erase a failed submission | Partial; source changes and focused checks | P21 |
| WEB-10 | Retained scoreboards do not schedule their own future activation | Partial; source changes and focused checks | P21 |
| WEB-11 | A settled task stops the retained thread's lifetime poll | Partial; source changes and focused checks | P21 |
| WEB-12 | Text-only reconciliation removes legitimately repeated provisional turns | Partial; source changes and focused checks | P21 |
| WEB-13 | Generated-card “ask” actions bypass the chat's busy exclusion | Partial; source changes and focused checks | P21 |
| WEB-14 | Shallow card eligibility suppresses prose for unsupported v1 content | Partial; source changes and focused checks | P21 |
| WEB-15 | Incomplete calendar evidence is still described as free | Partial; source changes and focused checks | P21 |
| WEB-16 | Generated sensitive facts leak through secondary projections | Partial; source changes and focused checks | P21 |
| WEB-17 | An old task poll can clear a newer task's state | Partial; source changes and focused checks | P21 |
| VH-02 | Call ledger omits charge components and does not reconcile the complete bill | Partial; source changes and focused checks | P22 |
| API-07 | Budget edits silently succeed on rejected input and use permissive numeric parsing | Partial; source changes and focused checks | P15 |
| APP-08 | Text-model selection can retain a non-text fallback | Partial; source changes and focused checks | P14 |
| AUX-MODELS-COST | Timeout/abort usage and metering failures need conservative durable reconciliation | Partial; source changes and focused checks | P15 |
| AUX-VOICE-CONTRACT | Realtime session readiness, tool-follow-up and cost estimation need provider contract qualification | Open | P22 |
| COST-03 | P1. Separate budget fallback from capability fallback | Partial; source changes and focused checks | P15 |
| COST-04 | P1. Put actual price constraints around latency selection | Partial; source changes and focused checks | P15 |
| COST-05 | P2. Improve reservations and cost evidence before tuning budgets | Partial; source changes and focused checks | P15 |
| COST-06 | P2. Stabilize safe prefixes; reduce redundant evidence, not essential context | Partial; source changes and focused checks | P15 |
| COST-07 | P2. Spend less reasoning only where the role passes without it | Open | P15 |
| COST-08 | Lower priority: avoid paid no-op extraction and embedding | Partial; source changes and focused checks | P15 |
| DESIGN-DECISIONS | Selective decision adapter and retrieval reranking, including Jev evaluation | Partial; source changes and focused checks | P15 |
| DM-02 | PostgreSQL routing upgrades can replace custom settings outside the retired field | Partial; source changes and focused checks | P15 |
| HC-10 | Audit index cannot discover old owner tasks beyond bounded recent results | Partial; source changes and focused checks | P00 |
| IOS-21 | Selecting another model can silently retain the previous model’s prices | Partial; source changes and focused checks | P15 |
| PG-07 | Accepted maximum task budget cannot fit the PostgreSQL field | Partial; source changes and focused checks | P15 |
| DESIGN-HORIZON | Responsive voice and bounded delegated outcomes over the existing runtime | Design proposal; implementation open | P23 |
| VH-01 | Existing call transcription default needs a dated provider migration | Partial; source changes and focused checks | P22 |

## Detailed improvement requirements

The following conditions, changes and acceptance criteria are transcribed from the original supplied review. Source statements about unrun tests or unperformed work refer to that original review, rather than the current implementation checkpoint. A partial implementation status does not certify these criteria. Repeated requirements retain their canonical finding identity; proposals remain proposals and the withdrawn item remains unsupported.

### APP-11: Local Gmail polling bypasses the migration activation fence

**Current status:** Implemented and locally verified.

**Observed condition:** a Firestore import is pending_activation, an owner row and configured Google connection exist, QUEUE_DRIVER=local runs the poller, and Gmail sync is enabled. Connected mailbox access and sync-state mutation can begin before the installation is explicitly activated. Depending on available message/model gates, ingest work can also start. This finding does not claim tasks execute before activation: task lease claim has an effective transactional migration gate.

**Required improvement:** one explicit operational-readiness contract for ticks, internal hooks, webhooks, model probes and queue admission. Preserve a separate opt-in read-only diagnostic mode if required. Enforce activation again inside durable ingress state writes so activation changes during a run cannot cross the boundary.

**Acceptance to establish:** actual configured module + poller + Firestore marker pending_activation, owner present, mocked Gmail; assert no mailbox/provider calls or sync state writes; activate and assert exactly one resumable sync; also deactivate between profile read and checkpoint. Inspect other ingress transports independently rather than assuming task-claim fencing covers them.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/poller.ts#L75-L116), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/poller.ts#L176-L193)

### AUX-API-PARSING: Real-auth, bounded-body and per-section API tests must run beyond mocks

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Route suites often mock authentication; many emulator-gated tests can be skipped. Bounded request parsing and typed validation vary by route.

**Required improvement:** Exercise real cookie/bearer/session boundaries and strict bounded parsers; report executed versus skipped suites and typed per-section failure/availability.

**Acceptance to establish:** Run same-origin, hostile same-site, invalid bearer, oversized body, malformed enum/number and one-section-failure cases through actual route composition in isolated environments.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/next.config.ts#L32-L62)

### AUX-MIGRATIONS: Upgrade, ownership, transform and recovery requirements span migration prefixes

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Fresh-database migration success does not certify every supported historical upgrade prefix, owner setting preservation, transformed data or rollback compatibility.

**Required improvement:** Add forward-corrective migrations, field-level owner provenance, actual schema invariant checks, bounded locking/batching and inert restore rehearsals.

**Acceptance to establish:** Exercise supported prefixes, interruption/retry, duplicates with references, custom owner settings and restored pending work. Verify invariants and zero external effects before recovery promotion.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle/0000_new_abomination.sql#L138-L174), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle/0000_new_abomination.sql#L232-L310), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle/0001_ambitious_franklin_richards.sql#L1-L27), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle/0006_amazing_surge.sql#L1-L11), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle/0015_material_mister_fear.sql#L1-L25), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle/0024_default_voice_profile.sql#L1-L10), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle/0025_icy_bullseye.sql#L1-L30), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle/0051_chubby_terrax.sql#L9-L22), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle/0064_exotic_lord_hawal.sql#L1-L2), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle/0066_warm_robin_chapel.sql#L1-L13), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle/0067_solid_midnight.sql#L9-L31), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle/0073_historical_approval_policy.sql#L1), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle/0080_cost_evidence.sql#L1)

### AUX-SINGLE-OWNER: Enforce one-owner installation or explicitly migrate global identities before multitenancy

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Global/singleton contacts, budgets, model roles, voice samples and caches assume one owner per installation. Multiple coexisting owners would invalidate that boundary.

**Required improvement:** Enforce the one-owner invariant at startup/import/repository entrypoints, or undertake a deliberate scoped-identity migration before multi-owner support.

**Acceptance to establish:** Attempt a second/foreign owner and stale imported linkage. Refuse unsupported coexistence or prove every read/write/cache/linked record is owner-scoped under the new contract.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/execution-context-repository.ts#L73-L108), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/persistence/src/execution-context.ts#L3-L5), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L172-L208), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/schema.ts#L234-L254), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/application-chat-repository.test.ts#L12-L24), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/application-chat-repository.test.ts#L59-L68), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/schema.ts#L1096-L1099), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/schema.ts#L483-L486)

### AUX-TOOLS-ISOLATION: Worker cancellation, process-tree lifetime and local byte/path limits need adversarial validation

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Worker cancellation may kill only the direct child; local input/output reads can exceed bounds or follow a final symlink. A timed-out browser plan may continue without an enforced whole-plan deadline.

**Required improvement:** Own process-tree lifetime and cancellation at an isolated execution boundary, validate canonical final paths, and enforce byte/time budgets before allocation. Preserve explicit local-runner limitations.

**Acceptance to establish:** Use disposable child/grandchild, hanging pipe, oversized file, symlink and long-plan fixtures. All descendants stop at the deadline and no disallowed bytes/path are read. Do not interpret this as a demonstrated cloud escape.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L69-L80), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/storage.ts#L52-L56), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/browser/launcher.ts#L78-L96)

### CC-01: Updating or rolling back applies a foundation-only configuration to the live runtime state

**Current status:** Partial; source changes and focused checks.

**Observed condition:** an initialized/ready consumer installation is moved to another release through consumer:update and follows its emitted next steps. Confidence: high for the incomplete-configuration/state collision; the actual live Terraform plan and mutation ordering were not executed.

**Required improvement:** keep a complete runtime-preserving desired configuration and prior runtime inputs throughout updates, or split foundation/runtime into separate states with a reviewed migration. Produce and inspect the exact plan, rejecting unexpected destruction/replacement before apply. Keep old healthy runtime/owner access until replacement readiness is established. A fresh-install foundation stage is not an update primitive.

**Acceptance to establish:** start with a state fixture containing initialized runtime services and IAM, then exercise rebase plus the actual Terraform planning path in a disposable/provider-mocked environment. Assert no runtime deletions or lost public/invoker bindings. Inject protected-service deletion failure and partial IAM operations; verify recovery preserves known-good access. Cover updates and rollback, Google/passkey modes, and interrupted retries. Existing scripts/consumer-lifecycle.test.ts:61–113 only mocks command success; installer tests cover fresh provisioning but not this state transition.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/consumer-update.ts#L60-L96), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/setup/src/consumer-lifecycle.ts#L23-L63), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/setup/src/consumer-install.ts#L407-L417), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/setup/src/consumer-install.ts#L504-L518), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/setup/src/consumer-install.ts#L1524-L1543), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/setup/src/consumer-install.ts#L1576-L1587), [reference 7](https://developer.hashicorp.com/terraform/language/meta-arguments/lifecycle), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/consumer/terraform/runtime.tf#L213-L269), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/consumer/terraform/runtime.tf#L272-L343), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/consumer/terraform/runtime.tf#L345-L368), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/consumer-lifecycle.test.ts#L61-L113), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/setup/src/consumer-install.ts#L1258-L1330), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/setup/src/consumer-install.ts#L1695-L1718), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/setup/src/consumer-install.ts#L915-L975)

### CC-02: Ready can be satisfied by an old or unrelated model call rather than a current owner response

**Current status:** Partial; source changes and focused checks.

**Observed condition:** an installation already contains a positive-output modelCalls row, such as from a prior release or background task. Confidence: high; this is a verification gap, not a claim that inference is broken.

**Required improvement:** bind a readiness transaction to installation, configured agent, current deployment/release, a specific post-deploy owner request and its terminal persisted/delivered reply. Check actual serving revisions. If keeping the weak usage check, label it historical provider usage and add a separate end-to-end readiness gate. Respect the current native-first product flow; browser chat redirect is not that test.

**Acceptance to establish:** prior-release call, wrong-agent/background call, provider tokens followed by failed delivery, old agent traffic despite a new ready revision, correctly delivered current owner reply, and no response. None should pass the stronger gate except the completed current flow.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/consumer-install.ts#L234-L263), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/setup/src/consumer-install.ts#L1258-L1330), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/setup/src/consumer-install.ts#L1695-L1718), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/consumer-install.test.ts#L492-L525), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/setup/src/consumer-install.ts#L915-L975), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/setup/src/consumer-install.ts#L407-L417), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/setup/src/consumer-install.ts#L504-L518), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/setup/src/consumer-install.ts#L1524-L1543), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/setup/src/consumer-install.ts#L1576-L1587)

### CC-03: A crash between a cutover mutation and its evidence write defeats rollback’s attempted-step detection

**Current status:** Partial; source changes and focused checks.

**Observed condition:** process termination, host loss, or evidence-write failure occurs after a remote mutation but before the completed step record is persisted. Confidence: high source-level crash window; no crash experiment was run.

**Required improvement:** durably record intent before the first mutation, with config/run identity and operation-level checkpoints. Reconcile uncertain actions against live state on resume/rollback. Treat missing completion after recorded intent conservatively, including divergence consent, and use resource-specific idempotency. Do not assume absence of evidence means absence of effects.

**Acceptance to establish:** terminate between each remote effect and journal commit, especially fence disable, first service traffic switch, and first dispatcher resume; restart in a new process and verify correct reconciliation/consent. Also fail the filesystem write after a successful remote action. Existing partial-quiesce and retry tests cover caught failures or manually changed state, not durable crash recovery: scripts/cutover-steps.test.ts:920–1025.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1883-L1935), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-evidence.ts#L87-L99), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1941-L1958), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1966-L1997), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-neon-fence.ts#L266-L272), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1383-L1392), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.test.ts#L920-L1025), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1890-L1907), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1833-L1851), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1941-L1960), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1966-L2044), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-evidence.ts#L140-L162), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1998-L2014), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L2045-L2075), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L298-L313), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L385-L400)

### CC-04: Rollback is not bound to the configuration and evidence chain that authorized the cutover

**Current status:** Partial; source changes and focused checks.

**Observed condition:** a valid config is edited or the wrong config/evidence directory pair is supplied to rollback; alternatively a prior result is changed without repairing its downstream hash. Confidence: high. No claim of untrusted remote code execution or a remote attacker is made.

**Required improvement:** before any rollback or forward mutation, validate the full config and require all relevant records, intent journal, and private rollback material to belong to one immutable run/config identity with a valid chain. Reject mismatched target config before credential/cloud reads. Make an explicitly reviewed target remap a separate recovery operation, never an implicit fallback.

**Acceptance to establish:** use the same evidence with edited project, region, Neon branch/endpoint, source secret, dispatch lists, and services; each must fail before the first cloud call. Corrupt prior result bytes or previousSha256 and assert both forward continuation and rollback refuse. A valid failed-step journal should still allow the intended rollback.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1890-L1907), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1833-L1851), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1941-L1960), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1966-L2044), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-evidence.ts#L140-L162), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1883-L1935), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-evidence.ts#L87-L99), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1941-L1958), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1966-L1997), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1383-L1392), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1998-L2014), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L2045-L2075), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L298-L313), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L385-L400)

### CC-05: Retirement can report READY after a rollback, including with a fresh inventory

**Current status:** Partial; source changes and focused checks.

**Observed condition:** a previously complete cutover has passed the elapsed window and other archive/asset gates, then production traffic is rolled back or drifts while the latest Cloud Run template remains Firestore. Confidence: high static path; no live retirement was attempted.

**Required improvement:** a rollback must invalidate the cutover’s retirement eligibility. Require a fresh bounded-age source fence, actual traffic/revision inspection, currently serving persistence identity, dispatcher state and health evidence before READY. Time elapsed should be “elapsed,” with separately attested observation/operational results. Read and verify retained backup/archive generations and required keys at the retirement boundary. Keep the tool report-only and retain explicit authorization for actual destructive retirement.

**Acceptance to establish:** complete cutover, restore old traffic while leaving latest template Firestore, then run report with fresh inventory; must be NOT READY. Also cover any rollback record, cached inventory beyond freshness limit, re-enabled source, serving old revision with PostgreSQL secrets, and verified fresh Firestore-only traffic. No false READY should emerge from metadata alone.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1998-L2014), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L2045-L2075), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L298-L313), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L385-L400), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-retirement-report.ts#L319-L370), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-retirement-report.ts#L631-L647), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-retirement-report.ts#L310-L328), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-retirement-report.ts#L581-L591), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-retirement-report.test.ts#L308-L331), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1883-L1935), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1941-L1958), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1966-L1997), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1383-L1392), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1890-L1907), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1833-L1851), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1941-L1960), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/cutover-steps.ts#L1966-L2044)

### DM-01: A journal timestamp inversion can skip the approval-policy uniqueness migration

**Current status:** Implemented and locally verified.

**Observed condition:** An installation first applies through 0020, then later upgrades to a release containing 0021. The stored maximum is already newer than 0021, so it is skipped. A fresh database applying the whole chain at once does not expose this: its initial watermark is empty. The upgrade can silently omit deduplication/uniqueness; current standing-rule creation can fail because its conflict target has no matching unique constraint. Once a newer migration is recorded, an ordinary rerun will not repair the skipped file.

**Required improvement:** retain already-applied SQL and journal history; add an explicitly reviewed forward corrective migration that checks/repairs the missing invariant, deduplicates safely with history repointing, and verifies the actual index definition. Add strictly monotonic journal validation for new entries and an applied-prefix/schema reconciliation gate. Do not just renumber historical timestamps, replay all old SQL, or delete migration history.

**Acceptance to establish:** fresh chain; every supported historical prefix, especially 0020; interrupted/retried corrective upgrade; missing/wrong-definition index; duplicates with referenced approvals; concurrent policy writes; rerun after later migrations. Validate actual schema and successful approve-and-remember, not only the migration-row count. All tests remain unrun.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle/meta/_journal.json#L145-L157), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/package.json#L13-L21), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle.config.ts#L6-L12), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle/0021_green_bullseye.sql#L1-L37), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/approval-repository.ts#L315-L335), [reference 6](https://github.com/drizzle-team/drizzle-orm/blob/0.45.3/drizzle-orm/src/pg-core/dialect.ts#L70-L107), [reference 7](https://github.com/drizzle-team/drizzle-orm/blob/0.45.3/drizzle-orm/src/migrator.ts#L21-L55), [reference 8](https://github.com/drizzle-team/drizzle-orm/blob/0.45.3/drizzle-kit/src/cli/connections.ts#L259-L282), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/package.json#L17-L21), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/approval-repository.ts#L263-L312)

### DM-04: The consumer pilot requires a browser chat that route policy forbids

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A new customer follows the documented sequence without an already paired native client. They cannot perform its browser first-message step and therefore cannot establish the model-response acceptance check by that path. The runbook also names the old bmson/aibot clone URL at line 48; no redirect or repository availability was independently checked, so that is a verification task rather than a claimed clone failure. The pilot itself honestly says no fresh real account has executed it (docs/consumer-fresh-account-pilot.md:3-5).

**Required improvement:** make an explicit product decision: a verified native-first install must provide app availability and pairing before first conversation, while a browser-capable install needs deliberate restoration and testing of that surface. Amend every setup handoff, Calls/Costs/approval link and pilot step to the chosen available client. Do not quietly reopen product routes as a docs fix or count a successful model probe as an actual customer chat.

**Acceptance to establish:** new account/project through claim, saved recovery credential, app distribution, pairing, first authenticated conversation, provider result and ready stage; denied permissions, failed pairing, expired claim and recovery; no preexisting owner/client/secret. Measure hands-on time separately from provisioning; test the exact published runbook.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/consumer-fresh-account-pilot.md#L112-L146), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/consumer-fresh-account-pilot.md#L152-L163), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/proxy.ts#L7-L40), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/product-guide.md#L70-L74), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/design-system.md#L19-L23), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/consumer-fresh-account-pilot.md#L3-L5), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/consumer-fresh-account-pilot.md#L241-L247)

### DM-05: Living guidance contradicts current driver, module, queue and release behavior

**Current status:** Partial; source changes and focused checks.

**Observed condition:** An operator treats top-level undated/current guidance as authoritative for setup, spend, release or retirement. They can choose the wrong profile or recovery procedure, troubleshoot nonexistent limitations, and mistake source/test availability for a deployed migration. These contradictions establish unreliable documentation, not proof of current production configuration or permission to inspect/change it.

**Required improvement:** maintain one release-scoped support matrix (driver, queue, auth, modules, client, provider/embedding space, known unsupported hooks), generated/checked against actual composition and routes. Give historical records dated status/supersession headers; retain their evidence. Record a separate current deployment receipt from read-only service/config/index/dispatch/client checks when authorized. Link PostgreSQL and Firestore runbooks explicitly. Do not infer cutover or safe database deletion from healthy /api/health, table coverage or test counts.

**Acceptance to establish:** executable safe example/config validation, route inventory drift check, all supported profile boots without the other datastore, configured end-to-end feature probes, and current image/driver/dispatcher/backup evidence. Keep real-cloud and emulator claims separate.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/firestore-cutover-checklist.md#L197-L232), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/firestore-implementation-status.md#L3-L7), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/firestore-agent-runtime-inventory.md#L3-L13), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/system-reference.md#L388-L390), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/consumer-fresh-account-pilot.md#L241-L247), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/config/src/index.ts#L468-L476), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/firestore-sweep.ts#L185-L211), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/modules.md#L63-L72), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/config/src/index.ts#L411-L435), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/firestore-web-route-inventory.md#L22-L29), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/recovery.md#L3-L11), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/firestore-cutover-checklist.md#L181-L194), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/workspace-migration.md#L70-L88), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/workspace-migration.md#L134-L146), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/consumer-fresh-account-pilot.md#L112-L146), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/consumer-fresh-account-pilot.md#L152-L163), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/consumer-fresh-account-pilot.md#L3-L5), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/recovery.md#L15-L39), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/modules.md#L18-L22)

### DM-06: The PostgreSQL restore drill starts a temporary runtime without fencing restored work

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A restored PostgreSQL snapshot contains pending/sleeping work or enabled schedules, and a temporary deployment reuses working provider credentials/default local dispatch while the source installation remains active. Merely starting the drill can run restored work or duplicate future notifications/effects. An empty target and healthy readiness response do not make that rehearsal inert. No restore or external effect was performed here.

**Required improvement:** define a verified inert restore profile before process startup: no live dispatch, provider egress or production callback routing, separate identity/queue/storage, restored privacy/tombstone state, and an explicit promotion boundary. Reconcile pending/unknown effects rather than replaying them. Treat backup integrity, restored data integrity, application readability and authorized recovery promotion as separate gates.

**Acceptance to establish:** restore with due tasks/reminders/approvals and fake providers; boot read-only rehearsal; assert zero provider calls, queue publications and outbound notifications. Verify data/object hashes and compatible app version, then explicitly authorize and exercise a bounded promotion. Test rollback without activating two schedulers.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/recovery.md#L15-L39), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/index.ts#L34-L39), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/poller.ts#L132-L193), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/firestore-consumer-install-plan.md#L231-L238), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/recovery.md#L3-L11)

### FS-15: Valid migration documents can form an oversized transaction that cannot resume

**Current status:** Partial; source changes and focused checks.

**Observed condition:** FS-15: Valid migration documents can form an oversized transaction that cannot resume (high severity for cutover availability, high confidence, new)

**Required improvement:** deterministic dual count/encoded-byte packing with conservative protobuf/path overhead, cursor by absolute write index, and preview reporting of maximum chunk size; handle index-write/transaction constraints conservatively. Proposed tests: large individually-valid records, multibyte strings, vectors and nested codec overhead; injected restart at a variable-size chunk boundary; require every chunk below the documented limit without live quota probing.

**Acceptance to establish:** large individually-valid records, multibyte strings, vectors and nested codec overhead; injected restart at a variable-size chunk boundary; require every chunk below the documented limit without live quota probing.

Source references: [reference 1](https://firebase.google.com/docs/firestore/quotas), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/workspace-migration.ts#L519-L533), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/workspace-migration.ts#L655-L675), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/workspace-migration.ts#L73-L81)

### IOS-13: Native review export does not bind build/runtime provenance to the actual test run

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The native review exporter hashes source at export time and supplies runtime metadata rather than binding those values to the actual xcresult build. Existing inspected runtime evidence agrees; no false deployed/runtime result is established.

**Required improvement:** Bind each capture to immutable tested build/source/device/runtime identity from the actual test run; label export-time metadata separately.

**Acceptance to establish:** Export an older xcresult after changing source/runtime metadata. Preserve the actual tested generation and mark any unknown provenance, rather than relabeling it current.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/tools/export-native-review.py#L16-L20), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/tools/export-native-review.py#L48-L55)

### IOS-14: Shipping guide contradicts APNs implementation and portrait shipping contract

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A release engineer following shipping.md is told no push entitlement/provider exists, despite implemented APNs registration and entitlement. README promises progress Live Activities that code deliberately suppresses. Orientation guidance also reflects an earlier state. These contradictions make provisioning and acceptance expectations unreliable; current CI status was not checked by this partition.

**Required improvement:** Derive release checklist from actual capabilities/build settings; correct push provisioning, notification privacy, orientation and system activity behavior.

**Acceptance to establish:** Documentation contract checks against plist/entitlements and release QA review; no inferred claims that CI/tests currently pass.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/docs/shipping.md#L34-L37), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/docs/shipping.md#L69-L73), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/README.md#L113-L128), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/System/LiveActivityManager.swift#L274-L282)

### OPS-01: Code job does not enforce its advertised network isolation

**Current status:** Partial; source changes and focused checks.

**Observed condition:** New cross-boundary confirmation with the tools reviewer; high confidence for checked-in deployment, no exploitation performed.

**Required improvement:** put untrusted code in a genuine isolated worker boundary with enforced deny-by-default networking, metadata denial and separate filesystem/process identity. Keep input retrieval, artifact upload and callback credentials in a broker outside that boundary. Enforce allowNetwork through policy-backed allowlists, not descriptive text. Merely adding VPC egress does not by itself isolate the child from metadata or its supervisor.

**Acceptance to establish:** disposable cloud project; approved synthetic script attempts Internet, metadata and sibling-process access with networking disabled and receives deterministic denials; broker input/output/callback still work. Test allowed networking separately. Never run the probe on the owner deployment.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/docker/code-runner.Dockerfile#L1-L5), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/deploy.sh#L547-L561), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L44-L55), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/storage.ts#L66-L105), [reference 5](https://docs.cloud.google.com/run/docs/securing/security), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/deploy.sh#L387-L389), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/deploy.sh#L510-L517), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/deploy.sh#L254-L264), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L97-L119), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/storage.ts#L96-L105)

### OPS-02: Current-only cleanup destroys project-wide secret history using a regional dependency inventory

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Other regions, non-Cloud-Run consumers, offline decryption/recovery dependencies and unrelated project applications are not inventoried. Their pinned older credentials can be destroyed. Stable preflight fingerprints protect against some concurrent drift but do not make the dependency set complete.

**Required improvement:** allowlist installation-owned secrets, never adopt all project secrets as cleanup targets; encode consumer/version references and cryptographic recovery dependencies; default to disable/quarantine with a recovery window; require a separate reviewed destruction step. Retain at least a known-good release and its secrets unless the user deliberately accepts rebuilding instead of rollback.

**Acceptance to establish:** fake cloud inventory with unrelated secret, another-region service, offline key dependency, aliased and numbered refs, and a concurrent rotation. No out-of-scope version may appear in deletion plan. Test post-deploy rollback using retained image/config/secret versions.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/cleanup-current.py#L114-L148), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/cleanup-current.py#L290-L302), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/cleanup-current.py#L240-L256), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/cleanup-current.py#L323-L328), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/cleanup-current.test.py#L100-L103), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/github-actions.md#L146-L184), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/github-actions.md#L126-L128)

### OPS-03: Self-repair's trusted guard permits Firestore owner-authentication code

**Current status:** Partial; source changes and focused checks.

**Observed condition:** New full-chain confirmation of an earlier protection-gap question; high confidence. Requires a repair candidate and later owner merge; no automatic production bypass asserted.

**Required improvement:** centrally classify protected security/persistence surfaces and deny the Firestore adapter by default (or define an explicit narrow capability tier). Add repository-enumerated regression tests for owner-auth and every auth/policy/credential entrypoint. Preserve independent untrusted-candidate verification, patch bounds, no-commit protection and human merge.

**Acceptance to establish:** guard contract rejects owner-auth.ts, its tests when security semantics are protected, Firestore schema/config/data-control files, newly named equivalents and renames; ordinary permitted UI repairs still work. Test both GitHub and hosted paths.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/persistence/src/repair-guard.ts#L11-L39), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/.github/workflows/self-repair.yml#L87-L132), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/.github/workflows/self-repair.yml#L190-L205), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/.github/workflows/self-repair.yml#L258-L270), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/.github/workflows/self-repair.yml#L301-L319), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/repair-patch.mjs#L44-L58)

### OPS-04: Consumer private-agent Cloud Tasks/Scheduler audiences conflict with Cloud Run IAM

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The application independently validates route-bound audiences (internal.ts:40–50), so changing only Scheduler's audience to the bare URL is incomplete. Terraform test:151–158 actually requires the incompatible combination; mocked plans cannot exercise IAM.

**Required improvement:** define a compatible two-layer authentication contract, such as explicit allowed custom audiences with verified forwarding semantics, or a platform service token plus separate application proof. Keep route authorization and caller identity checks; do not simply remove the security boundary. Align queue, scheduler, service configuration and application validators together.

**Acceptance to establish:** ephemeral real-cloud install, actual queue delivery and scheduler invocation, wrong service/route/caller rejection, cold-start dispatch and retry/outbox recovery. Record no user data and no external action.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/consumer/terraform/runtime.tf#L213-L224), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/consumer/terraform/runtime.tf#L459-L466), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/queue.ts#L44-L66), [reference 4](https://docs.cloud.google.com/run/docs/authenticating/service-to-service), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/routes/internal.ts#L40-L50), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/consumer/terraform/tests/passkey-dispatch.tftest.hcl#L151-L158), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/consumer/terraform/runtime.tf#L88-L94), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/consumer/terraform/runtime.tf#L213-L269), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/consumer/terraform/runtime.tf#L272-L343), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/consumer/terraform/runtime.tf#L345-L368)

### OPS-05: The generated local .env is rejected by its own schema

**Current status:** Implemented and locally verified.

**Observed condition:** .env.example:72 contains AUTH_TRUST_HOST= and 257 contains GMAIL_SYNC_ENABLED=. config/index.ts:119,273 declares optional true/false enums: optional accepts absent values, not an empty string. setup.ts:42–60 copies both unchanged into the generated .env, and config loads it through dotenv. The documented pnpm setup; pnpm config:check flow therefore fails parsing without a manual edit.

**Required improvement:** normalize intentionally blank optional values to undefined or comment unset placeholders. Test the actual freshly generated env against loadConfig, not only key-name parity. Existing env-example.test.ts only verifies that schema names are documented.

**Acceptance to establish:** pure/temp-directory generator test for minimal/all modules, no secrets printed, both unset and explicit true/false settings, invalid values rejected, mode0600 preserved.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/.env.example#L72), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/.env.example#L257), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/config/src/index.ts#L119), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/setup.ts#L42-L60), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/config/src/index.ts#L488-L500)

### OPS-06: Fresh legacy GCP provisioning cannot bootstrap its required agent URL

**Current status:** Partial; source changes and focused checks.

**Observed condition:** deploy.sh:387–389 gets the agent's URL only by describing an existing service. 510–517 deploys a cloudtasks/OIDC process without AGENT_URL/INTERNAL_OIDC_AUDIENCE on a fresh project. config/index.ts:488–500 rejects both absences and agent/index.ts:16–23 exits before listening. Because deployment is fail-fast, the intended second-pass URL update523–524 is unreachable.

**Required improvement:** derive deterministic service URL before initial creation (as consumer Terraform does), or a secure explicit bootstrap stage that can become ready without accepting work, followed by validated final configuration. Do not weaken normal production validation.

**Acceptance to establish:** empty-project provisioning simulation checks initial env completeness; authorized disposable-cloud first install plus idempotent second run; permission/network describe errors must not be treated as absence.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/deploy.sh#L387-L389), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/deploy.sh#L510-L517), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/config/src/index.ts#L488-L500), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/index.ts#L16-L23), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/deploy.sh#L547-L561), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/config/src/index.ts#L119), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/deploy.sh#L254-L264)

### OPS-07: Shipping agent dependencies differ from tested/audited lock and escape image JS scanning

**Current status:** Partial; source changes and focused checks.

**Observed condition:** OPS-07 , P2: Shipping agent dependencies differ from tested/audited lock and escape image JS scanning

**Required improvement:** deploy the locked production dependency closure, preserving SDK filesystem assets; scan actual shipping JavaScript dependencies; validate bundle externalization against the same SDK versions used by tests. Pin base/build tooling where reproducible rebuilds are required. Retain SBOM/signature work already present.

**Acceptance to establish:** compare installed shipping package/version graph with lock, scan the built image including runtime JS, perform emulator/real SDK smoke using the actual container and verify image digest/SBOM provenance. No package downloads or tests were performed in this review.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/docker/agent.Dockerfile#L40-L44), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/.github/workflows/deploy.yml#L188-L197), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/.github/workflows/deploy.yml#L78-L99)

### OPS-08: Consumer Google-auth native token provisioning is incompatible with read/rotation code

**Current status:** Partial; source changes and focused checks.

**Observed condition:** New cross-boundary confirmation with web reviewer; high confidence. Google-auth consumer runtime, not passkey mode. Native pairing can fail; Settings can also fail loading when access to the hardcoded secret returns403.

**Required improvement:** explicit installation credential store/capability contract: secret resource, pinned/dynamic version semantics, and whether rotation is supported. For an immutable externally managed credential, use injected value and disable unsupported rotation; do not grant broad new permissions as an implicit workaround.

**Acceptance to establish:** Google consumer with and without optional native token; passkey consumer; legacy Google; unauthenticated and expired tokens; secret403/404; rotation unavailable vs supported; every profile can render Settings safely.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/consumer/terraform/runtime.tf#L88-L94), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/lib/mobile-access-token.ts#L18-L39), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/settings/actions.ts#L246-L259), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/settings/page.tsx#L21-L52), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/consumer/terraform/runtime.tf#L213-L224), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/consumer/terraform/runtime.tf#L459-L466), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/consumer/terraform/runtime.tf#L213-L269), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/consumer/terraform/runtime.tf#L272-L343), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/consumer/terraform/runtime.tf#L345-L368)

### OPS-09: Live goal verification can run unrelated due schedules and removes real cost evidence

**Current status:** Implemented and locally verified.

**Observed condition:** OPS-09 , P2: Live goal verification can run unrelated due schedules and removes real cost evidence

**Required improvement:** isolated named rehearsal installation/database, dry-run/plan and explicit metered-live flag, scoped schedule runner, external-action test doubles/allowlist, retained immutable usage ledger marked as rehearsal rather than deleted, try/finally cleanup for fixtures only.

**Acceptance to establish:** unrelated due schedule untouched; synthetic provider usage still present after fixture cleanup; crash at each stage leaves discoverable cleanup manifest; refusing ordinary owner DB is default.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/verify-goal-session.ts#L36-L80), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/verify-goal-session.ts#L140-L154)

### OPS-10: Private Markdown voice samples are falsely described as gitignored

**Current status:** Implemented and locally verified.

**Observed condition:** voice README:1–5 invites .txt and .md writing samples and calls them gitignored. ingest-voice.ts:42–46 accepts both. .gitignore:18–20 ignores only .txt. Personal correspondence in .md can therefore appear as an ordinary unstaged file and be committed accidentally.

**Required improvement:** private samples outside the checkout or ignore the whole directory except its explicit documentation/examples. Add an ignore-policy regression for every accepted extension. No actual personal sample was inspected or found in this audit.

**Acceptance to establish:** For every accepted voice-sample extension, verify that a new private sample is ignored or outside the repository while intended public examples remain tracked. No personal sample may appear in an ordinary add/commit candidate set.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/seed-data/voice/README.md#L1-L5), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/ingest-voice.ts#L42-L46), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/.gitignore#L18-L20)

### OPS-11: Independent service rollout leaves incompatible versions live after a failed agent release

**Current status:** Partial; source changes and focused checks.

**Observed condition:** OPS-11 , P2: Independent service rollout leaves incompatible versions live after a failed agent release

**Required improvement:** release manifest with per-component digests, schema/API compatibility range and explicit independent-component selection. Stage no-traffic revisions, verify readiness and a synthetic cross-service transaction, promote compatible sets and retain rollback handles. Allow truly independent web-only releases with proven contract compatibility rather than every web update by default.

**Acceptance to establish:** agent fails before rollout; agent new revision unhealthy; web health fails; stale worker image; schema compatible/incompatible revisions; successful old/new mixed compatibility. Expected traffic must remain known-good on a failed release.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/release-postgres.sh#L349-L388), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/release-firestore.sh#L361-L398)

### OPS-12: Manual/local release paths do not perform the advertised source verification

**Current status:** Partial; source changes and focused checks.

**Observed condition:** New; high confidence, authorized operator escape hatch, not an unauthenticated deployment exploit.

**Required improvement:** distinguish retrying a deployment trigger from explicitly waiving failed checks. Require exact successful CI SHA for normal manual release; separately reviewed break-glass waiver records checks skipped, reason and known risk. Make local path consume already-verified immutable digests or apply equivalent gates. Update documentation to match real checks.

**Acceptance to establish:** failed/no CI SHA rejected by ordinary manual path; successful SHA accepted; fork/unrelated revision rejected; waiver conspicuous and auditable; no false statement that source tests ran.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/.github/workflows/deploy.yml#L78-L99), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/github-actions.md#L126-L128), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/cloudbuild.yaml), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/cloudbuild-firestore.yaml), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/github-actions.md#L146-L184), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/.github/workflows/deploy.yml#L188-L197)

### OPS-14: Demo people purge deletes the real owner's graph relations

**Current status:** Partial; source changes and focused checks.

**Observed condition:** New; high confidence. Trigger is running pnpm tsx scripts/demo-people.ts, with or without --purge, against any nonempty owner database while NODE_ENV is not literally production.

**Required improvement:** refuse ordinary owner databases; require disposable installation ownership sentinel and uniquely namespaced agent/fixture identifiers. Delete only explicit IDs created by that fixture run, in a transaction, retaining independent owner data. Until repaired, treat this utility as unsafe for any database worth preserving.

**Acceptance to establish:** seed a disposable DB with genuine-looking owner graph plus a demo fixture, run the pure mocked/isolated lifecycle and assert all unrelated nodes, edges, memories and contacts are byte-equivalent afterward. Validate both ordinary seed and --purge; fail on an unowned target before first write.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/demo-people.ts#L39-L50), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/demo-people.ts#L245-L263), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/demo-people.ts#L288-L292), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/demo-people.ts#L269-L285)

### OPS-15: Phone setup corrupts minimal module selection after changing Twilio state

**Current status:** Partial; source changes and focused checks.

**Observed condition:** This validation happens only at service startup after the script has already stored a token (140–170), potentially bought a phone number, and replaced existing number webhooks (173–223). A failed deploy may leave external telephony altered with no successful assistant configuration or automatic restoration of previous webhooks.

**Required improvement:** canonical parser/composition plan and complete readiness preflight before irreversible or externally visible changes. Preserve preexisting number webhooks and staged configuration in a recovery record. Choose an existing number without modifying its unrelated routing until the owner approves the exact transition. Require an obtained price before purchase rather than silently accepting pricing lookup failure. Keep phone purchase and provider access separately authorized.

**Acceptance to establish:** empty, minimal, all and explicit module sets; existing number with established webhooks; failed agent update after webhook preparation; failed web update; unavailable price; interrupted setup; repeated setup without duplicate purchases. All cloud/Twilio interactions mocked until a separately authorized isolated rehearsal.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/setup-phone.ts#L237-L256), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/config/src/modules.ts#L45-L46), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/setup-phone.ts#L140-L170), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/setup-phone.ts#L173-L223)

### OPS-16: Several older visual utilities write authoritative fixture conversations into the ordinary owner database

**Current status:** Partial; source changes and focused checks.

**Observed condition:** seed-qa-messages.ts:12–14,72–111 uses unguarded configured DATABASE_URL, selects an existing primary conversation and inserts invented user messages with origin: owner; the rest of the file adds fabricated bookings, weather, briefings and scores. Cleanup matches its namespaced channel IDs, but it does not remove any downstream memory/commitment extraction already produced while fixtures were present. chat-readability.ts:49–91,94–160 similarly uses the existing owner agent, writes owner-trust conversations and can run real metered model requests without a dedicated rehearsal target. Even its url command creates a conversation when state is absent.

**Required improvement:** one disposable-target validator and test-owned identity for any fixture writer; no fixture origin: owner in a running ordinary installation; isolate background workers; store fixture provenance and cleanup artifacts; optional live generation separate from staging, with explicit spend cap and immutable run evidence.

**Acceptance to establish:** ordinary owner DB and remote DB rejected before writes; primary conversation unchanged; synthetic generated content cannot enter owner recall; cleanup does not touch non-fixture data; interrupted run leaves a cleanup manifest.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/seed-qa-messages.ts#L72-L111), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/visual-qa/chat-readability.ts#L94-L160)

### OPS-17: Selective screenshot recapture can relabel stale evidence as current CSS evidence

**Current status:** Implemented and locally verified.

**Observed condition:** OPS-17 , P2: Selective screenshot recapture can relabel stale evidence as current CSS evidence

**Required improvement:** immutable per-capture HTML/component/CSS/build hashes, timestamp and evidence mode. Invalidate or visibly mark all affected captures stale when shared inputs change; never associate a new global source hash with an old capture. Keep static, hydrated-synthetic, real-route and native-device evidence distinct.

**Acceptance to establish:** capture A/B under CSS hash1, modify global CSS, recapture only A; A is current hash2 and B is explicitly stale hash1. Full current-coverage claim must fail until every affected capture is refreshed. Verify selective runs do not overwrite baseline provenance.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/product-visual-qa.ts#L785-L793), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/product-visual-qa.ts#L874-L895)

### R2: Integration tests can destroy or corrupt unrelated data

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Broad cleanup and shared-owner fixture writes can alter unrelated records in a valuable/shared *_test database. Normal pnpm test rejects production and validates its target; CI is ephemeral. Direct Vitest/test:firestore has a TEST_DATABASE_URL exception, and standalone utilities have separate risks.

**Required improvement:** Enforce a disposable target ownership sentinel and per-run owner/fixture identities in one connection factory; validate both database variables. Scope cleanup to allocated IDs and guard standalone utilities separately. Preserve current root safeguards.

**Acceptance to establish:** Reject ordinary or unowned targets before any write. In disposable tests, seed unrelated sentinels and prove they survive success, failure, forced termination and parallel suites; verify both DATABASE_URL and TEST_DATABASE_URL invocation paths.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/schedules.test.ts#L77-L87), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/schedules.test.ts#L543-L564), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/missions.test.ts#L55-L70), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/maintenance.test.ts#L34-L118), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/maintenance.test.ts#L180-L290), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/model-call-audit.test.ts#L111-L138), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/improve-decisions.test.ts#L17-L139), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/improve.test.ts#L78-L86), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/improve.test.ts#L349-L397), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/suggestions.test.ts#L272-L284), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/maintenance.test.ts#L238-L303), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/consolidation.test.ts#L175-L179), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/voice-ingest.test.ts#L280-L304), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/graph-gaps.test.ts#L119-L129), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/nudge-policy.test.ts#L23-L45), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/location.test.ts#L126-L154), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/arrival.test.ts#L62-L77), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/profile/commands.test.ts#L13-L74), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/profile/commands.test.ts#L100-L194), [reference 20](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/location.test.ts#L6-L29), [reference 21](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/dispatcher.test.ts#L268-L360), [reference 22](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/reminders.test.ts#L35-L51), [reference 23](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/application-chat-repository.test.ts#L12-L24), [reference 24](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/application-chat-repository.test.ts#L59-L68), [reference 25](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/vitest.config.ts#L14-L41), [reference 26](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/test.ts#L5-L39), [reference 27](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/profile-library-parity.test.ts#L21-L24), [reference 28](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/test-firestore.ts)

### TW-18: Deployed code-worker permissions cannot stage its declared inputs

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A deployed code job includes any GCS-staged input. Its GET has no object-read grant from this deployment and fails before the script, despite the advertised ability to analyze downloaded/filed inputs. Separate output-key reuse may also fail with creator-only permission (TW-04)

**Required improvement:** Preserve least privilege. A trusted broker should materialize only specifically approved immutable inputs into a credentialless, network-denied child environment, and accept bounded verified outputs under an execution-specific path. Do not repair this simply by granting objectViewer to model-authored code or giving it the parent worker's callback/storage authority

**Acceptance to establish:** In a deploy-equivalent disposable environment, stage one authorized immutable input and reject foreign/protected inputs or digest changes. The child has no metadata/network/read credential; unique outputs and one authenticated callback survive cancellation/retry.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/deploy.sh#L254-L264), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L97-L119), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/storage.ts#L96-L105), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L161-L183), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L132-L140), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L111-L119), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/deploy.sh#L547-L561), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L44-L55), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/storage.ts#L66-L105), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/deploy.sh#L387-L389), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/infra/gcp/deploy.sh#L510-L517)

### API-01: Anonymous invalid bearer tokens bypass the secret-read cache

**Current status:** Partial; source changes and focused checks.

**Observed condition:** On a reachable Cloud Run deployment using the legacy mobile token, an unauthenticated caller can repeatedly submit arbitrary non-asd1_ bearer values to any mobile endpoint and force credential/secret-service traffic before rejection. A warm cache does not bound this behavior. Cold-cache requests can first fetch normally and then fetch again after the failed comparison. This creates an avoidable quota, latency and cost amplification point on the authentication boundary; Secret Manager failure then also affects legitimate token verification. This is not a token-disclosure or authentication-bypass claim.

**Required improvement:** Bound mismatch-triggered refresh by a short per-instance cooldown and global abuse controls, or issue versioned/signed credentials whose generation can be checked without a secret read per rejection. Keep the normal expiry refresh and rotation semantics explicit. Never recover from secret-read failure by accepting the stale startup secret.

**Acceptance to establish:** Exercise the actual isMobileAuthed path, not its common mock: many sequential invalid tokens, overlapping invalid tokens, valid warm token, valid newly rotated token, expired cache, Secret Manager outage, owner-session fallback and passkey device keys. Assert an upper bound on metadata/secret calls and a documented maximum rotation/revocation delay. mobile-auth.test.ts currently tests only the constant-time comparison helper; mobile-access-token.test.ts:31–45 tests explicit refresh but does not bound the mismatch path.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/mobile-auth.ts#L18-L35), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/lib/mobile-access-token.ts#L13-L45), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/mobile-auth.test.ts), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/lib/mobile-access-token.test.ts#L31-L45), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/mobile-auth.ts#L37-L42)

### API-02: Same-site cross-origin requests can use owner cookies on mobile mutations

**Current status:** Partial; source changes and focused checks.

**Observed condition:** SameSite separates sites, not origins. A hostile sibling origin under the same registrable domain can submit a simple text/plain POST carrying JSON to the assistant origin with cookies included. Reading the response is unnecessary for a write. A __Host- cookie prevents setting a parent-domain cookie; it does not prevent the browser sending the target host's cookie in a same-site request. For such deployments, this can reach consequential owner actions, including the irreversible erasure example. Ordinary unrelated cross-site pages are mitigated by the Lax cookie, so this is not a claim that any website can do it.

**Required improvement:** Distinguish successful bearer authentication from cookie fallback. For unsafe methods authenticated by cookies, require the configured exact Origin or an equivalent CSRF token; preserve originless native requests only when their bearer credential actually succeeds. Consider requiring recent owner verification for irreversible erasure and credential/policy changes.

**Acceptance to establish:** Actual cookie auth with same-origin, hostile same-site sibling Origin, cross-site Origin, absent Origin and Origin:null; simple text bodies containing valid JSON; explicit valid/invalid bearer with cookies also present. Check rejection before any persistence/model call. Keep /api/owner's existing exact-origin defense.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/mobile-auth.ts#L37-L42), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/lib/owner-auth/runtime.ts#L84-L92), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/lib/owner-auth/runtime.ts#L113-L139), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/memory/profile/route.ts#L66-L85), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/approvals/%5Bid%5D/route.ts#L9-L46), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/mobile-auth.ts#L18-L35), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/lib/owner-auth/runtime.ts#L143-L149), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/lib/owner-auth/runtime.ts#L14-L110)

### API-03: PostgreSQL object mutations do not consistently enforce the owner checked on reads

**Current status:** Partial; source changes and focused checks.

**Observed condition:** An authenticated owner who knows a foreign/stale agent object's UUID can mutate it if such rows coexist in the PostgreSQL database. Random UUIDs are not an authorization boundary. The skill edit can also make foreign instruction text owner-authored. Firestore counterparts bind the configured agent and include substantial foreign-ID tests, so this is a driver-parity gap, not a blanket claim that all API owner isolation is absent.

**Required improvement:** Pass configured agent identity explicitly to every mutating repository method and include it in the write predicate. Validate linked-record ownership too, including anomaly → approval policy. Perform related mutations atomically and return authoritative not-found/conflict outcomes. If singleton storage is an absolute product invariant, enforce it at startup and schema/repository boundaries rather than relying on convention.

**Acceptance to establish:** Two agents plus a stale/migrated foreign row, all affected route operations and both drivers, malformed/missing IDs, cross-owner anomaly-policy linkage, and no external embedding call before foreign skill rejection. Preserve valid same-owner behavior.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/anomalies/%5Bid%5D/route.ts#L12-L25), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/lib/workspace-reviews.ts#L35-L48), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/operations.ts#L23-L34), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/anomaly.ts#L365-L392), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/skills/%5Bid%5D/route.ts#L75-L107), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/operations.ts#L88-L110), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/skills.ts#L225-L257), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/memory/occasions/%5Bid%5D/route.ts#L15-L46), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/profile/commands.ts#L650-L675)

### API-06: Successful task-control responses do not identify what actually changed

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A task may have completed, disappeared or moved to another state between display and a Stop/Retry tap. Transport success alone does not establish cancellation or a new runnable task. Treating it as a terminal-state receipt can mislead the client while work has already completed or the requested transition never occurred. Idempotent repeat cancellation is valid, but it should be distinguishable from an already-completed task.

**Required improvement:** Return typed outcomes with current status, relevant state/queue generation and whether a transition occurred: cancelled, already-cancelled, already-terminal, retried, no-longer-retriable, not-found. Keep cancellation fencing/checkpoint behavior distinct from “every external effect stopped immediately.”

**Acceptance to establish:** Completion racing cancel, repeated cancel, missing task, foreign task, duplicated retry and retry racing another state transition. Contrast the good commitments/route.ts:56–65, which preserves a false mutation result as a conflict, and improvement receipts that expose enacted:false.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/activity/%5Bid%5D/route.ts#L63-L104), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/tasks/commands.ts#L9-L58), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/memory/commitments/route.ts#L56-L65)

### API-10: Goal target-date validation permits normalized nonexistent dates

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A malformed date submitted by a client is persisted as a different real date and incorporated into goal scheduling/instructions. A date-only target is represented as midnight UTC, so callers must also avoid later treating it as an arbitrary local instant.

**Required improvement:** Use one shared strict calendar-date parser that verifies the resulting year/month/day round-trip and defines year bounds; preserve a date-only value when that is the domain meaning. Reuse the stricter occasion-validation approach already exercised by occasions/route.firestore.test.ts:68–83.

**Acceptance to establish:** February 29 in leap/non-leap years, February 30, April 31, invalid months, year boundaries, empty/null target, creation/update parity and cross-timezone rendering.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/goals/route.ts#L29-L38), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/goals/%5Bid%5D/route.ts#L57-L66), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/memory/people/%5Bid%5D/occasions/route.firestore.test.ts#L68-L83)

### APP-12: A failed prior document attempt suppresses a fresh explicit read

**Current status:** Partial; source changes and focused checks.

**Observed condition:** the owner fixes sharing/credentials or asks to re-read an updated document after an earlier failed attempt. The deterministic read guarantee is removed by the earlier attempt; a model may choose to retry voluntarily, but a tool-less response can finish without reading. A prior attempt is not evidence that this renewed request has been satisfied.

**Required improvement:** bind read attempts and successful content/version evidence to the current request; distinguish conversational references to already-read material from explicit fresh read/retry intent. Preserve failed-attempt provenance without using it as completed-read evidence.

**Acceptance to establish:** prior permission denial, restored access, new explicit read request; assert a new read and current contents. Cover fresh edit after prior success, plain followup reusing evidence, and repeat permission failure without loop. Existing fixture should stop treating the failed prior attempt as sufficient reason to suppress a fresh request.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/firestore-executor.test.ts#L130-L202), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/intent.ts#L17-L31)

### CF-05: Chat admission has no stable retry identity

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A retry of one accepted POST can therefore append a new message and create a new task. No claim is made that the current iOS/web client actually retried in this incident. Add an authenticated conversation-scoped client operation ID shared by message persistence and task admission, and return the existing acceptance receipt on replay. Two intentional sends need different operation IDs.

**Required improvement:** Persist a client operation ID and immutable triggering-message/context boundary at admission. Reuse that identity on transport retry while allowing a new intentional same-text request.

**Acceptance to establish:** Lose the admission response and retry with the same operation ID: one task/message/effect. Submit identical text intentionally with a new ID: two valid tasks. Queue A and B before execution and confirm each retains its own trigger.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-turn.ts#L442-L504), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-turn.ts#L662-L680), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/task-creation-repository.ts#L23-L68), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/task-creation.ts#L19-L25), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L85-L89), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L85-L134)

### CF-08: An owner request can be mislabeled as an external request

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The guard is phases.ts:492–505: it refuses if state.untrustedContext is truthy OR task trust is neither owner nor assistant. Empty reasoning is consulted only after this guard to select a fallback mission statement. There is no empty-reasoning branch that emits this refusal.

**Required improvement:** distinguish owner-authored authorization, requester identity, and tainted supporting data. Retrieve the card actually referenced by the current turn rather than admitting up to four unrelated cards because it contains a generic pronoun. Preserve the prompt-injection boundary for any data retained. Do not merely clear untrustedContext or allow model-authored mission statements to launder external instructions into trusted future work. Build any durable instruction from the bounded owner-authorized request, carry external references as untrusted data, and retain execution-time tool policy. If the current runtime cannot safely establish that boundary, ask the precise missing confirmation and describe it accurately instead of claiming an authenticated owner is an external requester.

**Acceptance to establish:** An owner request referencing the correct untrusted historical card retains owner authority and data taint separately. Unrelated pronouns do not inject a stale card; a third-party instruction cannot create a mission.

Source references: [reference 1](https://bot.bmson.com/audit/3140a072-31f3-49db-af46-ff27974b1522), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L492-L505), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/conversation-context.ts#L83-L121), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L260-L268), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L210-L233), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L206-L208), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L448-L450), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L240-L250), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L492-L514), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L451-L515), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L503-L514), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L229-L230)

### FS-01: Approval chat hydration loses the tool name

**Current status:** Partial; source changes and focused checks.

**Observed condition:** any stored approval with a linked tool call using normal encoded IDs. Proven impact: the application receives undefined toolName despite an existing tool. Verified downstream impact: application chat.ts577–589 calls approvalRule with toolName or an empty string; the missing name removes the supported remember-rule label from a pending approval. Fix: key by String(doc.get('id')) and validate the link to the owning task. Proposed test: create approval + linked gmail.send tool; assert both hydration arrays retain gmail.send, including an ID containing slash. Existing hydration test checks only approval IDs, missing this projection.

**Required improvement:** key by String(doc.get('id')) and validate the link to the owning task. Proposed test: create approval + linked gmail.send tool; assert both hydration arrays retain gmail.send, including an ID containing slash. Existing hydration test checks only approval IDs, missing this projection.

**Acceptance to establish:** create approval + linked gmail.send tool; assert both hydration arrays retain gmail.send, including an ID containing slash. Existing hydration test checks only approval IDs, missing this projection.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/application-chat.ts#L664-L683), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/application-chat.ts#L112-L207), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/store.ts#L54-L58)

### HC-03: Task identity and latest intent are not a coherent runtime boundary

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The planner and execution detectors operate on the latest user message in that window. Example: enqueue “Create a packing-list document” (A), then independently “Create a grocery-list document” (B), then start both workers. Both can see B as their latest instruction. The source does not deterministically bind A to its own request, so A can be dropped or B performed twice. The exact model output is not guaranteed; the missing task/message boundary is.

**Required improvement:** Persist task identity, triggering message identity, and a cursor/intent version. Distinguish later messages that: refine the same task cancel it answer a pending question request separate work are unrelated conversation

**Acceptance to establish:** Two queued independent requests keep their own exact instruction and each execute once Queue order B-before-A does not rebind A to B Retry of the same incoming request is idempotent by stable message/request ID New correction between seed and cursor baseline is included exactly once Correction while a read is blocked takes effect before subsequent mutation Approval at T1, cancellation at T2, execution attempt at T3: no stale effect Correction at T1, explicit approval at T2: respect the actual reviewed exact arguments and explain any remaining mismatch Unrelated B does not cancel A A stale worker cannot publish a misleading final after cancellation/replacement Both PG and Firestore adapters satisfy the same concurrency contract

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-turn.ts#L498-L506), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-turn.ts#L662-L669), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L90-L114), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L137-L148), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/task-creation-repository.ts#L15-L66), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/task-lease-repository.ts#L40-L61), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/tasks.ts#L27-L52), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/task-runner.ts#L7-L35), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/use-chat-polling.ts#L342-L347), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/proxy.ts#L29-L42), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L313-L335), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L232-L280), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1147-L1192), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L171-L181), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L268-L276), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L151-L166), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/task-lease-repository.ts#L16-L23), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1161-L1192), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1429-L1447), [reference 20](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L90-L97), [reference 21](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L516-L545), [reference 22](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L300-L418), [reference 23](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L579-L598), [reference 24](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L811-L828), [reference 25](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L150-L175), [reference 26](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1385-L1409), [reference 27](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-turn.ts#L597-L629), [reference 28](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-turn.ts#L253-L264), [reference 29](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1122-L1135), [reference 30](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L59-L83), [reference 31](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L210-L222)

### HC-05: Clarification can finish before the sources that would answer it are loaded

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The planner is told to search before asking and not re-ask answered questions: planner.ts:125–151.

**Required improvement:** Retrieve eligible conversation, memory and source context before deciding whether clarification is necessary; preserve explicit no-read scope and honest missing coverage.

**Acceptance to establish:** Known recipient/address in contacts or durable memory: retrieve, do not ask again Earlier explicit answer outside the 20-row window: retrieve and preserve it Two equally plausible recipients after retrieval: one focused question Reversible formatting ambiguity: act on a sensible default Critical missing fact with no available source: ask once and persist the exact unresolved slot Answer to a clarification resumes the correct task and is not treated as a wholly unrelated obligation Planner-provider failure must not become guessed outward-facing data Truncation must preserve an explicit representation of known task constraints, not just whatever text fits

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/planner.ts#L125-L151), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/planner.ts#L72-L98), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L90-L97), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L516-L545), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L300-L418), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/planner.test.ts#L18-L53), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1161-L1192), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L90-L114), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L137-L148), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L232-L280), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1147-L1192), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L171-L181), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L268-L276), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L151-L166), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1429-L1447), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L579-L598), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L811-L828), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L150-L175), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1385-L1409), [reference 20](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1122-L1135), [reference 21](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L59-L83), [reference 22](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/planner.ts#L104-L121)

### HC-07: Later owner changes suppress recovery but not obsolete completion requirements

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The checklist correctly prevents one successful action from hiding omitted compound outcomes. It also stops automatic recovery when a newer owner instruction exists: step-loop.ts:1385–1409.

**Required improvement:** Revision the requested outcome checklist when the owner changes or cancels part of the work; finalization must use the current request rather than obsolete original requirements.

**Acceptance to establish:** Original request has outcomes A+B. Owner cancels B and retains A. A succeeds. B is safely not retried, but remains pending in the original checklist. Finalization can report the request unfinished and erase the model's useful explanation of the changed scope.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1385-L1409), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L278-L291), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/golden/golden.e2e.test.ts#L228-L285), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1161-L1192), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L232-L280), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1147-L1192), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1429-L1447), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L145-L173), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L300-L418), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L579-L598), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L811-L828), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L150-L175), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1122-L1135), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L757-L770), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L589-L596), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L656-L692), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L738-L755), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L636-L668)

### HC-11: Ordinary physical-card text can be promoted to an explicit UI-card obligation

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A single ordinary “library card” mention is explicitly excluded. PHYSICAL_CARD includes library, and requestedCardIntent removes that match before looking for a remaining standalone card word: card-intent.ts:9–39.

**Required improvement:** Separate ordinary mentions of physical cards from explicit interface-composition intent. Respect cardable false and retain a useful prose outcome without inventing a failed save.

**Acceptance to establish:** Compare physical greeting/payment/cards text, literal quoted card instructions, and explicit native UI-card requests. Only the explicit UI request creates that obligation; all ordinary content remains answerable.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/card-intent.ts#L9-L39), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L589-L596), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L59-L83), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/generative-card.ts#L312-L315), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/generative-card.ts#L779-L799), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L656-L692), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L738-L755), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L636-L668), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/generative-card.ts#L674-L715), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L90-L114), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L137-L148), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L171-L181), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L151-L166), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L145-L173), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L90-L97), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L278-L291), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L757-L770)

### HC-12: Planner mistakes tainted third-party content for positive owner intent

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Do not clear taint, promote unknown senders to owner, or widen their tool registry to make these plans succeed. Represent source actor, whether there is a new request, quoted versus newly authored content, and owner-authorized scope explicitly before planning. A reaction is ordinarily acknowledgment of prior content, not a new instruction to replay the quoted request.

**Required improvement:** Represent owner-authored goals separately from third-party source text and its taint. Require positive owner intent for any external action; do not turn a quoted source suggestion into an owner request.

**Acceptance to establish:** Feed tainted newsletter/audit/document instructions inside an authenticated owner request. The planner preserves the owner goal and never promotes source text to positive authorization; legitimate owner follow-through still works.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L210-L222), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/planner.ts#L104-L121), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/context-helpers.ts#L77-L87), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/registry.ts#L39-L58), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/dispatcher.ts#L438-L447), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L313-L335), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/planner.ts#L125-L151), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/planner.ts#L72-L98)

### MC-03: Localized/unknown quoted owner email bypasses direct-email taint

**Current status:** Partial; source changes and focused checks.

**Observed condition:** owner forwards/replies with quoted third-party words using an unrecognized localized/client format or quote markers outside the retained 20K text prefix. No claim that attacker can forge the owner sender.

**Required improvement:** preserve MIME quotation/forward structure and provenance spans; unknown mixed authorship defaults to tainted. Keep explicit fresh-owner instruction separately addressable, rather than tainting away the owner's request or considering a model confidence score authority. Proposed tests: localized forward/reply headers, HTML blockquote stripping, plain copied text, marker beyond cutoff, sender authentication pass/fail, direct versus forwarded mode, then assert actual dispatcher authorization and voice-sample exclusion.

**Acceptance to establish:** localized forward/reply headers, HTML blockquote stripping, plain copied text, marker beyond cutoff, sender authentication pass/fail, direct versus forwarded mode, then assert actual dispatcher authorization and voice-sample exclusion.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/email-provenance.ts#L15-L49), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L1058-L1128), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L207-L233), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/voice.ts#L10-L35), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L927-L1031), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L629-L693), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L515-L557)

### MC-04: Card observer executes before unauthenticated direct email is rejected

**Current status:** Partial; source changes and focused checks.

**Observed condition:** direct mode, card feature enabled, inbox receives spoofed booking-shaped mail. Authenticated unknown senders can also induce work before deep-triage flood limits. Existing link/image stripping is preserved but does not authenticate card facts or cap paid generation.

**Required improvement:** put admission and authentication/provenance gates before observer fanout; add explicit per-message durable observer status/idempotency, independent rate budget, and unverified-source labeling where forwarded mode intentionally accepts unauthenticated mail. Do not discard legitimately forwarded mail merely to match direct-mode policy.

**Acceptance to establish:** spoofed From/failed authentication booking fixture with cards enabled; assert zero model/persistence/notification before direct-mode rejection. Forwarded-mode policy separately tested. Replay identical gmail message and crash after composer success must not cause repeated charged composition. Existing tests fully read: email-cards.test.ts uses authenticated:true for its shared event and never exercises the unauthenticated path; card dedupe test dedupes owner notice after composition, not the paid call itself.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L927-L1031), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/module.ts#L109-L124), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-cards.ts#L79-L123), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L1058-L1128), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/module.ts#L126-L186), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/module.ts#L200-L219), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L629-L693), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L515-L557)

### MC-05: Explicit Gmail sync disable is ignored by Pub/Sub ingress

**Current status:** Partial; source changes and focused checks.

**Observed condition:** module/credentials remain installed with an existing watch and owner sets GMAIL_SYNC_ENABLED=false. A later Pub/Sub poke still reads and ingests the mailbox.

**Required improvement:** centralize gate around sync for all entrypoints; explicitly decide whether manual sync may override and expose it separately. Tests: same config false across tick, internal, Pub/Sub, and already-running drain transitions.

**Acceptance to establish:** same config false across tick, internal, Pub/Sub, and already-running drain transitions.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/runtime.ts#L12-L17), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/module.ts#L126-L186), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/module.ts#L109-L124), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/module.ts#L200-L219)

### PG-02: Approval expiry is not enforced at decision time

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A still-pending decision is answered after its stated deadline but before the expiry sweeper changes its status. This does not establish an execution expiry for a grant already validly approved.

**Required improvement:** Atomically require the pending decision to be within its answer deadline and reject expired remember-rule derivation. Keep any separately designed execution-validity deadline distinct; preserve unchanged valid approvals across ordinary budget waits.

**Acceptance to establish:** Pause expiry sweep; answer just before, at and after deadline on both adapters. No late pending decision is approved. Also approve in time, then wait for budget past the answer deadline: unchanged valid grant survives unless an explicit execution expiry applies.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/approval-repository.ts#L263-L312), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/approval-repository.ts#L81-L114), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/approval-repository.ts#L370-L426), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/approvals.ts#L563-L664)

### R12: Calendar directions ignore the day the owner requested

**Current status:** Implemented and locally verified.

**Observed condition:** at10:00 today, the owner asks directions to “my3pm tomorrow”; both today and tomorrow have15:00 appointments at different locations. The deterministic path selects today's event and calculates today's departure. Two simultaneous matches also silently select the first. “My annual dentist appointment” can match an earlier unrelated “Annual review” because named terms use some, not a full entity match. Partial calendar results are accepted by successfulLookup, so missing calendars do not trigger ambiguity/coverage caution.

**Required improvement:** reuse one typed request-time/date resolver, bind an event reference to its requested day, require all significant terms or a stable selected event ID, and clarify genuinely ambiguous matches. Carry calendar coverage into selection and do not declare a unique destination over incomplete evidence.

**Acceptance to establish:** today/tomorrow same clock, explicit weekday beyond36h, same title on two days, two concurrent calendars, partial coverage, a requested event already underway, and multiword name collisions. Existing test531 only verifies that a tomorrow question routes into this branch; selection tests use one same-day match.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/live-lookup.ts#L274-L308), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/live-lookup.ts#L320-L339), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/live-lookup.ts#L464-L466), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/live-lookup.ts#L584-L609)

### R7: Direct Google Doc routing ignores an explicit prohibition on reading

**Current status:** Partial; source changes and focused checks.

**Observed condition:** owner says “Do not open just explain what a Google Doc URL looks like.” First mention is automatically dispatched to docs.get regardless of requested no-read constraint. Downstream risk approval does not replace intent validation and ordinary owner reads may be autonomous.

**Required improvement:** common typed request/negative-scope parser before any deterministic force. A bare URL can default to read only when not quoted, hypothetical, an example, or explicitly forbidden. Preserve ability to open a genuinely requested URL.

**Acceptance to establish:** explicit don't/read/open prohibitions, quoted translation, URL example, multiple URLs with one approved target, bare URL positive control. Current tests cover bare positive URL and non-Google URL only.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/artifact-intent.ts#L83-L85), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L275-L281), [reference 3](https://docs.google.com/document/d/abcdefghijk/edit)

### R9: Historical calendar questions are forced into future date windows

**Current status:** Implemented and locally verified.

**Observed condition:** Related next-item issue: next event sets maxResults1 (854–858,918–920), while generic range starts at today's midnight, not request instant. A morning event can consume the sole result for an afternoon “what is my next event?” request. Downstream exact handling needs calendar-tool confirmation, but the admitted temporal scope is already wrong. ISO-date parsing also lacks the calendar-validity round trip used by named dates.

**Required improvement:** typed temporal intent (past/future, direction, anchor, interval and granularity), request-clock binding, explicit handling of historical relative periods, and no silent future fallback when a recognized temporal phrase is unsupported. Next-event query starts at request instant and applies global ordering after merging calendars. Validate actual ISO calendar dates.

**Acceptance to establish:** yesterday across midnight/DST, last weekday/week/month/year, “last Friday” on Friday, explicit past named date without year, next event after already-finished same-day event, multiple calendars, invalidFeb30/13thmonth. Existing date tests cover upcoming Monday, upcoming named date and springDST; the next-event test asserts only maxResults1, not selected instant.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/read-intent.ts#L279-L387), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/read-intent.ts#L542), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/read-intent.ts#L1097-L1121), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/read-intent.ts#L854-L920)

### TW-02: A failed MCP preparation can remove the mandatory approval binding

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Preparation fails (for example a temporary connection-read failure), so an approval is created without _approvalMcpScope. The connection is changed or restored before execution. Because missing scope is accepted, the pending approval can execute without proving the target/configuration that was approved

**Required improvement:** Distinguish cosmetic fail-soft preparation from mandatory security preparation; do not park or execute MCP without a trusted binding, and check the required binding again after approval, including legacy calls

**Acceptance to establish:** Actual dispatcher plus actual MCP registrar; first connection read rejects, later succeeds or points to changed endpoint/credential/tool schema; no outbound call until fresh bound approval. Keep an unrelated voice rewrite failure safely recoverable Existing test limitation: mcp-approvals.test.ts:137-147 covers changed targets only when preparation succeeded; dispatcher.test.ts:1247-1257 replaces execute, so it does not prove the complete binding lifecycle

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/dispatcher.ts#L555-L569), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/mcp.ts#L610-L635), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/dispatcher.ts#L218-L321), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/dispatcher.ts#L816-L838)

### TW-03: Delayed approved execution does not revalidate current prohibitions

**Current status:** Partial; source changes and focused checks.

**Observed condition:** An already-approved action is delayed, then the owner installs a prohibition or the capability becomes forbidden before execution resumes. The old decision can still run. A cancellation racing claim is an additional persistence/runtime boundary to reconcile rather than a claim that all cancellation paths fail

**Required improvement:** Revalidate current hard denies, trust/capability, connection and outbound scope, plus task/intent cancellation at the external-effect claim. Preserve unchanged valid grants; distinguish a pending decision answer deadline from any explicit execution-validity expiry.

**Acceptance to establish:** Approve, block on budget, add matching deny, resume; forbid/remove capability; narrow configured outbound domains; revoke/cancel during preparation and before provider call; assert no effect and a truthful revoked receipt

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/dispatcher.ts#L218-L321), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/tool-execution-repository.ts#L21-L105), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/dispatcher.ts#L555-L569), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/dispatcher.ts#L816-L838)

### TW-07: Public weather/maps capabilities expose the private owner-location fallback to external tasks

**Current status:** Partial; source changes and focused checks.

**Observed condition:** An external task invokes weather.lookup with no place while the owner has a retained location. Private owner-location context becomes available in an external-origin workflow, contrary to the registry's no-confidential-read invariant. Outbound receipt paths would determine whether this reaches a sender; this review does not claim that final disclosure occurred

**Required improvement:** Split public explicit-place weather from owner-context weather, or add a runtime owner/assistant trust check before latestLocation, including before cache reuse. Capability metadata and cache partitioning must reflect argument-dependent private reads

**Acceptance to establish:** Actual registry+dispatcher+weather tool for every trust tier, absent/blank place, populated private location, cached owner-location response, explicit public place, tainted owner request and revoked location sharing. External fallback must not access owner context or reuse a private cached result Same defect in maps.directions: packages/tools/src/maps.ts:34-56 reads latestLocation when origin is absent and passes its coordinates/label into route generation, but77-81 assigns empty capability flags. Apply the split/runtime check and cache discipline to both tools; this is one shared capability-classification defect

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/builtin/weather.ts#L339-L379), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/maps.ts#L34-L81)

### TW-08: Investigating audit evidence can make the offered repair-report approval ineffective

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Owner asks to investigate an audit and report a bug; reading the audit taints the task. The dispatcher can ask the owner to approve improvement.report, but the actual tool still returns recorded:false. An approval is presented that cannot enable the action

**Required improvement:** Make preflight and execution eligibility agree. For an explicit owner report request, bind report authorization to the owner instruction and exact approved content while retaining untrusted evidence provenance; otherwise explain the restriction without offering an ineffective approval

**Acceptance to establish:** Real audit read followed by report under owner authorization, approval/resume, and third-party-only report instruction. No malicious report should become authorized merely because it was found in audit evidence

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/builtin/audit.ts#L13-L36), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/builtin/self-repair.ts#L17-L25)

### TW-11: File-prefix allowlists run before path normalization

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A path such as code/../browser/profile.tar.enc passes the code/ prefix gate but resolves to the protected profile area within workspace. This defeats the documented “never profile/secrets” boundary without escaping the workspace root. The Gmail route still has its ordinary send approval, and the profile is encrypted; do not claim decryption or actual transmission. Code staging can also read disallowed workspace namespaces

**Required improvement:** One canonical path validator that rejects traversal/backslashes/ambiguous segments, then checks the canonical allowed namespace. Prefer opaque purpose-scoped artifact IDs with expected digest/version. Apply validation before any read and bind approved uploads to immutable bytes

**Acceptance to establish:** Dot and dot-dot segments, backslash variants, leading slash, encoded names, symlink final components, protected sibling namespaces and valid nested attachments. Browser upload's stricter isAttachmentPath check is a useful existing defense to reuse

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/gmail.ts#L164-L179), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/workspace-store.ts#L51-L57), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L111-L119), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L161-L183), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L132-L140), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/gmail.ts#L294-L337), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L97-L119)

### TW-12: Raw Gmail labels bypass the archive approval tier

**Current status:** Partial; source changes and focused checks.

**Observed condition:** archive:false plus removeLabels:['INBOX'] is autonomous yet performs the same hiding operation as archive:true, which requires approval. Other consequential system labels (for example TRASH/SPAM) are not classified. The sender/task trust gates remain; this is an action-equivalence gap in the owner workflow risk gate

**Required improvement:** Derive risk from effective normalized label operations, not a convenience boolean; explicitly allow ordinary labels and classify system-label mutations, recipient-visible changes and deletion semantics consistently

**Acceptance to establish:** Equivalent direct/convenience archive payloads, TRASH/SPAM, markRead conversions, contradictory duplicate labels, policy allow scope and tainted owner tasks

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/gmail.ts#L294-L337), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/gmail.ts#L164-L179)

### TW-13: Collaborative Google edits are incorrectly treated as private-only writes

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The target document/sheet/deck is shared with another person, a group, or publicly. A model-influenced write becomes visible to that audience while bypassing the outward/network approval boundary. A bot-created file can later become shared, so creation provenance alone is insufficient. This is not an observed injection exploit or production disclosure

**Required improvement:** Treat remote collaborative mutations as outward-capable by default. A narrower private-write exception must establish current approved audience/permissions and bind it to execution; authorization needs destination, audience and data scope. Keep purely local notes separately classified

**Acceptance to establish:** Owner-only artifact, direct/group/domain/public sharing, inherited/shared-drive access, sharing changes between planning and execution, tainted model arguments, existing bot-created artifact shared later, and each Docs/Sheets/Slides mutation

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/docs.ts#L137-L168), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/sheets.ts#L154-L220), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/slides.ts#L227-L253), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/slides.ts#L64-L75), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/slides.ts#L241-L250)

### APP-03: Chat cursor's full-page shortcut defeats late-commit protection

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Chat cursor's full-page shortcut defeats late-commit protection

**Required improvement:** use a commit-ordered append sequence/event cursor with replayable dedupe; at minimum do not infer age from page fullness and bound transaction timestamp assumptions. Regression: hold one old-timestamp insert uncommitted, insert >pageSize newer messages, poll to hasMore/cursor advance, commit delayed row, assert it is delivered exactly once by ID. Include delayed commits >15s and concurrent reload/new-send cursors. No execution performed.

**Acceptance to establish:** hold one old-timestamp insert uncommitted, insert >pageSize newer messages, poll to hasMore/cursor advance, commit delayed row, assert it is delivered exactly once by ID. Include delayed commits >15s and concurrent reload/new-send cursors. No execution performed.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat.ts#L824-L882)

### APP-05: Approval email overclaims that nothing has happened

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Approval email overclaims that nothing has happened

**Required improvement:** say the listed actions await approval and show completed receipts separately. Regression: completed benign write + pending send in the same task, ensure notice identifies only unsent action and does not deny prior completed work. Separate from runtime pending-approval batch checkpoint loss reported by runtime reviewer.

**Acceptance to establish:** completed benign write + pending send in the same task, ensure notice identifies only unsent action and does not deny prior completed work. Separate from runtime pending-approval batch checkpoint loss reported by runtime reviewer.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/executor-deps.ts#L38-L44), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/executor-deps.ts#L12-L20)

### APP-06: Task audit timestamp pagination can permanently omit equal-time events

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Task audit timestamp pagination can permanently omit equal-time events

**Required improvement:** stable total-order tuple cursor across timestamp, event kind and ID; fetch pageSize+1 from each stream with matching tie-break order. Regression:101 same-time tool calls, mixed event kinds sharing timestamps, and microseconds truncated by JavaScript Date; every ID remains reachable once.

**Acceptance to establish:** 101 same-time tool calls, mixed event kinds sharing timestamps, and microseconds truncated by JavaScript Date; every ID remains reachable once.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/tasks/queries.ts#L328-L353), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/tasks/queries.ts#L414-L427), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/tasks/queries.ts#L495-L525)

### APP-09: Production notification fanout can stamp total delivery failure as success

**Current status:** Partial; source changes and focused checks.

**Observed condition:** the task's own conversation notice is absent/fails and both dashboard+phone legs fail (or the one relevant leg fails while others no-op). Production wrapper resolves anyway, stamps notified and makes stalled-attention repair treat it as delivered. Existing executor.e2e.test545–596 explicitly tests the intended retry but injects a throwingPush directly, bypassing this composition.

**Required improvement:** per-leg typed delivery receipts (delivered/skipped/failed/unknown), durable retry/outbox and idempotent message identity. Preserve fanout isolation while propagating all-effective-legs-failed to caller. Regression: actual agentServices/executorDeps with every leg failing, verify no attention stamp, recovery delivers once; also first leg succeeds/second fails and all skipped. Do not rerun completed user actions while repairing notice delivery.

**Acceptance to establish:** actual agentServices/executorDeps with every leg failing, verify no attention stamp, recovery delivers once; also first leg succeeds/second fails and all skipped. Do not rerun completed user actions while repairing notice delivery.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/deps.ts#L606-L627), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/deps.ts#L337-L367), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/notices.ts#L186-L249)

### AUX-CONTRACT-SHAPES: Checkpoint shapes, money/time validators and import link constraints need real contract round-trips

**Current status:** Implemented and locally verified.

**Observed condition:** Shared checkpoint/approval shapes, monetary precision, timestamp precision and cross-record import links can differ between producers and consumers even when each helper test passes.

**Required improvement:** Round-trip real checkpoints and receipts through recovery and both adapters; centralize strict money/date codecs and validate same-owner/same-parent linked identities.

**Acceptance to establish:** Round-trip a genuinely parked approval through recovery; test microsecond cursors, boundary money/date values and foreign/mismatched card/segment links; require compile-time contract checks as well as runtime tests.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/persistence/src/execution-context.ts), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/workspace-migration.ts), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/workspace-migration.ts)

### AUX-TOOLS-IDENTITY: Gmail/artifact keys conflate operation identity with title or nondeterministic content

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Gmail and document-creation keys use nondeterministically rewritten content or incomplete title/recipient identity. Multi-stage create/fill/share can fail after creating an external object.

**Required improvement:** Use durable operation IDs independent of display/content equivalence; freeze prepared payload and retain external object IDs at each resumable stage.

**Acceptance to establish:** Retry after creation/fill/share or response loss: one intended artifact/send remains. Two intentional same-title or same-recipient requests remain distinct, and changed approved bytes cannot reuse an old decision.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/gmail.ts#L185-L217), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/gmail.ts#L262-L264)

### CF-01: Mission session instruction loss and recursive creation

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Task 2645a07d-7ece-4efc-b6d3-0091e80c0071 is type adhoc, trust owner, parentTaskId e394a6b0-b2c0-4a77-9116-8d57279f375d, goalId null Its trigger source is mission_wake, with externalEventId mission:e394a6b0-b2c0-4a77-9116-8d57279f375d:session:0 Its trigger payload contains the correct instruction to perform the next increment and call mission.update The expanded actual plan-model input omits that session instruction and instead contains the old chat request and prior mission confirmations The DeepSeek plan-model result is action mission; the task progress is “spawned mission 9414dd02…” The task's final is the exact canned mission confirmation, with the resulting mission prefix matching the screenshot The audit records attempt 0, reclaim 0, tool actions 0, and step 0. This is fresh child execution taking the early planning branch, not a reclaimed attempt or a repeated tool side effect The audit list shows successive newly spawned mission prefixes 9af149cd → e394a6b0 → 9414dd02 → 68737981 → 37110794 → 3872b5ef during 07:16–07:18 UTC. The initial owner task prefix 72af586e (“check twice a day”) spawned b4c86431

**Required improvement:** Preserve mission instructions in seedContext, force/validate a bounded existing-mission execution mode, and reject nested root creation at the runtime boundary even when the model asks for it. Retain parent/goal identity intentionally. Separate initial admission from continuation/update/cancel/status intents. Use existing source task dedupe for replay, and an explicit linked mission identity for continuation rather than fuzzy global text deduplication. Make persisted mission plans replayable across every boundary.

**Acceptance to establish:** Create one bounded mission, run multiple child sessions through both adapters, restart at each lifecycle boundary and verify one root, correct current child instructions, bounded descendants and one final outcome.

Source references: [reference 1](https://bot.bmson.com/audit/2645a07d-7ece-4efc-b6d3-0091e80c0071), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/missions.ts#L80-L97), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/missions.ts#L226-L246), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L85-L134), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/context-helpers.ts#L25-L39), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L240-L250), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/planner.ts#L122-L139), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L492-L514), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/missions.ts#L42-L72), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L451-L515), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/planner.ts#L174-L187), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.test.ts#L88-L155), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/firestore-goals-missions.test.ts#L386-L473), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/missions.test.ts#L83-L132), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L503-L514), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L229-L230), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L85-L89), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/missions.ts#L25-L70), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/missions.ts#L243-L246), [reference 20](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/missions.ts#L291-L294), [reference 21](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L492-L505), [reference 22](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L260-L268), [reference 23](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L210-L233), [reference 24](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L206-L208), [reference 25](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L448-L450)

### CF-02: The repeated confirmation is deterministic product copy

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Same-task final replay already has protections: finalize.ts:155–172 checks an existing final by task/conversation/text; finalize.ts:293–296 checkpoints pendingFinal before delivery; executor.ts:229–230 resumes it. The live audit confirms that the inspected screenshot confirmation names a newly created mission rather than a simple re-render of one final.

**Required improvement:** Generate one meaningful confirmation from the authoritative outcome and occurrence identity; suppress repeated stock confirmation text that adds no new decision or result.

**Acceptance to establish:** Run repeated wake/retry/confirmation paths for the same unchanged operation. Emit only the meaningful requested confirmation; a genuinely changed outcome produces a new precise update.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L503-L514), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L155-L172), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L293-L296), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L229-L230), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L240-L250), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L492-L514), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L451-L515), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L75-L81), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L492-L505), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L260-L268), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L210-L233), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L206-L208), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L448-L450)

### CF-03: Reminder cards show superseded creations as active

**Current status:** Partial; source changes and focused checks.

**Observed condition:** response-cards.ts:550–584 accumulates reminder.create and reminder.list results in a Map keyed by reminder ID. It never processes reminder.cancel. Creation results lack enabled, so enabled defaults to true. response-cards.ts:1080–1088 independently creates a cancellation status card. response-cards.ts:1336–1342 places status cards before reminder cards, regardless of operation chronology. response-cards.ts:66–73 excludes prior-task receipts. This is an intra-task projection defect, not evidence that all conversation history is being displayed. execution-evidence-repository.ts:31–41 orders the PostgreSQL ledger by step, creation time, and ID.

**Required improvement:** create one chronological effective-reminder-state reducer shared by cards, final claims, and completion checks. Successful cancellation tombstones that exact ID; failed or ambiguous cancellation must not. Replacement should have one concise final-state surface and retain operation history in audit detail. A cancellation in one task should not indiscriminately hide unrelated reminders. Consider authoritative final state reads where projections can race with settings edits or other tasks.

**Acceptance to establish:** Create then cancel or replace a reminder in one turn and across turns. Cards, prose, Activity and later history distinguish the current inactive/replaced state from the historical creation receipt.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-cards.ts#L550-L584), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-cards.ts#L1080-L1088), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-cards.ts#L1336-L1342), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-cards.ts#L66-L73), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/execution-evidence-repository.ts#L31-L41), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L370-L382), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/request-checklist.ts#L173-L205)

### CF-04: Reminder creation is not retry-idempotent

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Process dies after schedule creation commits but before the tool result/checkpoint becomes durable; re-execution creates an independent duplicate reminder. A relative inMinutes replay can also shift the firing time. The same class deserves checks for watch.create/watch.web (watches.ts:159-175,202-223) and goals.create, whose adapters decide the final creation identity

**Required improvement:** Stable operation ID derived from the persisted tool-call/logical request, atomically bind it to the created schedule, return a replay receipt, and resolve relative times once when intent is recorded. Do not collapse two intentional separate requests merely because their text matches

**Acceptance to establish:** Crash at every insertion/result boundary; repeated dispatched invocation; two intentional identical reminders; relative-time approval/replay; both persistence drivers

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/reminders.ts#L101-L181), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/dispatcher.ts#L816-L838), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/dispatcher.ts#L555-L569), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/dispatcher.ts#L218-L321), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/reminders.ts#L103-L181), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/dispatcher.ts#L816-L855), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1180-L1216), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/question-regression/scenario-corpus.ts#L583-L597), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/question-regression/scenario-grader.test.ts#L46-L63), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/reminders.ts#L61-L129), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1163-L1179), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L232-L259), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L604-L615)

### CF-06: “After the game tomorrow” has no enforced temporal dependency

**Current status:** Partial; source changes and focused checks.

**Observed condition:** reminders.ts:61–99,114–129 supports an absolute ISO instant, a relative minute delay, or recurrence. It validates schedule shape and future-ness, but has no game/event identity, reference instant, end-time provenance, or “after actual completion” semantics. step-loop.ts:1163–1179 runs grounding for calendar.create_event and sheets.create, not reminder.create. step-loop.ts:232–259 anchors deterministic reads to task.createdAt but lines 604–615 supplies runStartedAt to the generic model prompt. chat.ts:321 explicitly tells the model to resolve tomorrow against that clock. A retry across local midnight can change a model-computed reminder date even though reads retain the original date. live-lookup.ts:63–68,75–97 forces sports lookup for sports questions/imperatives; the plain reminder wording does not trigger that route. This does not mean the model cannot voluntarily read calendar/sports sources.

**Required improvement:** Bind relative timing to the originating request clock, timezone, intended event occurrence and its actual completion dependency; ask if the event or stopping condition cannot be resolved.

**Acceptance to establish:** planner “schedule” means future action, while SCHEDULE_DIRECTIVE:75–81 specifically demands task.schedule. Ordinary reminder creation should satisfy its own durable reminder contract, not induce an extra future assistant task.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/reminders.ts#L61-L129), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1163-L1179), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L232-L259), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L604-L615), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/chat.ts#L321), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/live-lookup.ts#L63-L97), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L75-L81), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L155-L172), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L293-L296), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/reminders.ts#L103-L181), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1180-L1216)

### CF-07: Mission cadence is dropped, and recursive roots escape the original mission budget

**Current status:** Partial; source changes and focused checks.

**Observed condition:** PlanSchema, events.ts:63–72 has no cadence, frequency, or schedule field. Twice-daily wording can survive in reasoning/steps/progress without becoming a scheduling parameter missions.ts:25–27,48–70 specifies a 30-day default mission deadline, 24-hour wake interval, and 7-day reflection interval. startMission does not set runAfter or parentTaskId newTaskRecord:78–83 therefore creates a pending task with no parent. enqueueTask:87–107 forwards those fields directly and notifies the queue immediately for a new pending task After a session, missions.ts:243–246 schedules now + 24 hours. The active-child wait at lines 192–194 and reflection-continue at 291–294 do the same. Progress text does not alter these calculations

**Required improvement:** persist explicit cadence and timezone, validate it against the owner's requested frequency, return the actual next run, and use the persisted cadence on every wake/reflection/resume path. Distinguish interval-based checks from local-time schedules and define catch-up/overlap behavior. Prevent recursive creation rather than relying on aggregate budget alarms. Link root work identity across all descendants and account for its full authorized effort. Review whether a bounded twice-daily mailbox check belongs in a durable schedule instead of an open-ended mission; whichever route is selected must implement the same requested cadence and lifecycle.

**Acceptance to establish:** Request twice-daily work in an explicit timezone, cross DST and delayed worker starts, then stop it. Persist intended cadence/lifetime, bound overlap and charge descendants to the original authorized mission.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/events.ts#L63-L72), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/missions.ts#L25-L70), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/persistence/src/task-creation.ts#L78-L83), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/machine.ts#L87-L107), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/missions.ts#L243-L246), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/missions.ts#L291-L294), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/mission-repository.ts#L26-L36), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/missions.ts#L71-L80), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/missions.ts#L80-L97), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/missions.ts#L226-L246), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/missions.ts#L42-L72)

### DM-03: Retiring the default morning brief also disables owner-customized schedules

**Current status:** Partial; source changes and focused checks.

**Observed condition:** An installation crosses 0076 with an enabled, owner-edited morning-brief whose behavior is no longer a duplicate default. It is silently disabled along with the default, dropping recurring work. This does not claim that the default should remain duplicated, that the wake path is still broken, or that already-applied migration 0076 reruns on each release.

**Required improvement:** keep applied migration history immutable. Provide an upgrade review/forward recovery report for affected custom schedules; do not blindly re-enable every old row. Going forward, track seed provenance/template revision separately from a display name, preserve owner-enabled/disabled choices, and migrate only a known default variant unless the owner explicitly chooses replacement.

**Acceptance to establish:** default duplicate is retired; custom instruction/cadence remains or gets a reviewable migration; owner-paused row stays paused; repeated seed does not resurrect it; first-app-open fires only the supported brief; migration outcome is visible.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle/0076_disable_morning_brief.sql#L1-L13), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle/0026_occasions_morning_brief.sql#L1-L19), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/seed.ts#L197-L204), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/schedules.ts#L663-L681), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/seed.ts#L47-L48)

### FS-13: A late/replayed callback can revive a timed-out job or overwrite an already-recorded result

**Current status:** Partial; source changes and focused checks.

**Observed condition:** FS-13: A late/replayed callback can revive a timed-out job or overwrite an already-recorded result (high severity, high confidence, new cross-adapter race)

**Required improvement:** durable one-shot execution-job identity with terminal CAS; consume callback token and settle task checkpoint/result/files/wake in the same transaction. Return the same outcome for identical accepted retries; reject differing or timed-out retries. Proposed tests: timeout-first then valid-token callback; callback-first then timeout; re-claim then duplicate/different-result callback; assert one terminal result, one artifact set and one logical wake. Authentication alone is insufficient.

**Acceptance to establish:** timeout-first then valid-token callback; callback-first then timeout; re-claim then duplicate/different-result callback; assert one terminal result, one artifact set and one logical wake. Authentication alone is insufficient.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/execution-jobs.ts#L167-L282), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/job-callback.ts#L22-L71), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L176-L228), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/execution-jobs-repository.ts#L151-L248)

### HC-01: Native Stop stops observation, not execution

**Current status:** Partial; source changes and focused checks.

**Latest local checkpoint:** Operation-keyed server cancellation is installed in both persistence adapters and the authenticated web/mobile endpoints. Cancellation before admission suppresses that exact operation without adding a message; internal cancellation markers remain absent from public Activity and discovery. The focused batch passed 261/261 tests across 21 files with no skips, followed by all five static/build checks at unchanged source `3ee02d6f` (3,663 files). Web and native Stop caller integration, native runtime and the original end-to-end acceptance remain open. Detailed receipts and limits are recorded in `.workspace/playbook-review/root-checkpoint-status.md`; this finding is not promoted.

**Observed condition:** The owner sees “Stop the assistant” and “You stopped this turn,” but only the phone’s observation is cancelled. Server work and outward effects can continue. Switching chats becomes possible while the original server task remains alive. This reconfirms the prior audit finding; it is not counted as a novel defect.

**Required improvement:** Server idempotent cancellation with acknowledged stopping/stopped and distinguish detach from cancel.

**Acceptance to establish:** Stop before receipt, during tool execution, during approval and after effect committed; verify honest state and no post-cancel dispatch.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2636-L2661), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/ChatView.swift#L1934-L1999), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/ChatView.swift#L2135-L2145), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/ChatView.swift#L568-L598), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/ChatView.swift#L2033-L2145), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2803-L2821), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L1298-L1318), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2735-L2746), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2832-L2843), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2896-L2919), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2949-L2966), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L750-L801), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L403-L429), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L678-L703), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/ChatView.swift#L1934-L1998), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2637-L2661), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2316-L2324), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Networking/APIClient.swift#L161-L170), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/activity/%5Bid%5D/route.ts#L64-L91), [reference 20](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/task-lease-repository.ts#L16-L23), [reference 21](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1161-L1192), [reference 22](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/task-lifecycle-repository.ts#L175-L191), [reference 23](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/task-activity-commands.ts#L104-L117), [reference 24](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2896-L2911), [reference 25](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2913-L2928), [reference 26](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2948-L2964), [reference 27](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/task-lease-repository.ts#L40-L61), [reference 28](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L232-L280), [reference 29](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1147-L1192), [reference 30](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1429-L1447), [reference 31](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L300-L418), [reference 32](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L579-L598), [reference 33](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L811-L828), [reference 34](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L150-L175), [reference 35](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1385-L1409), [reference 36](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2862-L2870), [reference 37](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1122-L1135)

### HC-02: Native poll failure/timeout can say “Your result is ready”

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A terminal task state never arrives, the 30-minute client observation window ends, or polling errors break the loop. finalStatus remains nil and is treated as success, with a finished/result-ready notice. The selected reply text can even be an older assistant row. This reconfirms the prior finding.

**Required improvement:** Explicit outcome algebra and persisted task reconciliation; unknown/interrupted remains unresolved.

**Acceptance to establish:** Polling exhausts with only transport errors or deadline no terminal => no success notification.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2832-L2843), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2896-L2919), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2949-L2966), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2803-L2821), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L1298-L1318), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2735-L2746), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2636-L2661), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L750-L801), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L403-L429), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L678-L703), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2896-L2911), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2913-L2928), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2948-L2964), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/System/NotificationManager.swift#L113-L118), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/System/LiveActivityManager.swift#L294-L314), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2637-L2661), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2316-L2324), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2862-L2870)

### HC-04: Correct silence from proactive work becomes an error

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Arrival nudges are assistant-trust adhoc tasks instructed to send nothing and finish empty when no useful recommendation is found: arrival.ts:139–161.

**Required improvement:** Use an explicit, validated successful-silent outcome for background jobs authorized to self-silence. Empty foreground answers and truncated/failed provider responses must remain failures. Do not make all empty strings successful.

**Acceptance to establish:** Arrival observed; current ambient location is unavailable or no useful source-backed suggestion exists; model correctly returns empty with finishReason stop. Runtime changes this to “I couldn't finish the reply…” and needs_attention. The task that should quietly succeed instead burdens the owner.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/arrival.ts#L139-L161), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/seed.ts#L255-L267), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/schedule-runner.ts#L70-L85), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1429-L1447), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L145-L173), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1161-L1192), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L232-L280), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1147-L1192), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L300-L418), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L579-L598), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L811-L828), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L150-L175), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1385-L1409), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L278-L291), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1122-L1135), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L757-L770), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L589-L596), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L656-L692), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L738-L755), [reference 20](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L636-L668)

### HC-08: Future-notification request becomes a read-only answer, then an honest dead end

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Personal-read detection includes “tell” and “when,” plus interview/mail subject words: read-intent.ts:103–128 Its mutation exclusions do not include notify, watch, monitor, or let-me-know: read-intent.ts:150–153 A synthetic phrase such as “Tell me when the outcome email for my interview arrives” can therefore enter the deterministic calendar/email lookup path instead of creating future work After the forced reads, the answer turn has toolChoice none and drops any returned tool calls: step-loop.ts:811–828,1033–1037 Missing-background evidence is replaced in finalization and marked needs_attention; this late contract failure has no corresponding action-recovery phase: response-contract.ts:2249–2268, finalize.ts:757–770

**Required improvement:** Interpret future notification/watch requests as bounded durable work when authorized; choose a supported schedule/watch contract and report its exact creation or blocker, rather than only answering the current status.

**Acceptance to establish:** “Tell me if X emails me” versus “Has X emailed me?”: future watch and present lookup remain distinct “Check whether X replied; if not, notify me when they do”: complete the read and create the bounded future carrier when warranted A known exact sender can be resolved by read tools, then watch creation is allowed under normal policy Truly ambiguous outcome-versus-any-followup scope: ask one question, no false setup claim, then create the correct watch once answered Successful watch.create/watch.web receipt + future-notification wording passes a tool-specific contract Prior-task, cancelled, expired, failed or wrong-target watch does not prove this new monitoring request is active If the final contract catches a missing authorized action, run bounded recovery with no replay of completed effects; if recovery cannot act, preserve concrete blocker and useful prior results Never weaken the response contract to make the unsupported promise pass

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/read-intent.ts#L103-L128), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/read-intent.ts#L150-L153), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L811-L828), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L2249-L2268), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L757-L770), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/watches.ts#L153-L187), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/watches.ts#L196-L235), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L406-L412), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1161-L1192), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L232-L280), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1147-L1192), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1429-L1447), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L145-L173), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L300-L418), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/read-intent.ts#L990-L1022), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/read-intent.ts#L1045-L1087), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L1068-L1095), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L579-L598), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L2098-L2105), [reference 20](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L150-L175), [reference 21](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1385-L1409), [reference 22](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L278-L291), [reference 23](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1122-L1135), [reference 24](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L589-L596), [reference 25](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L656-L692), [reference 26](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L738-L755), [reference 27](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L636-L668)

### MC-01: A placed call's selected voice route is not frozen for media connection

**Current status:** Partial; source changes and focused checks.

**Observed condition:** an owner/provider configuration update between placing the call and opening its media stream. The live model can differ from the model used for the reservation and durable record; potentially a different approved provider destination.

**Required improvement:** snapshot immutable connection/model/voice/rates identity in the approved call/session; resolve that session route, revalidate that it is still allowed, fail closed rather than silently adopting a changed global role. Reconnect should retain the same snapshot. Proposed test: delay media start, mutate role A→B, assert connect uses A (or explicitly refuses if revoked), reservation/actual evidence agree, and B receives no call content.

**Acceptance to establish:** delay media start, mutate role A→B, assert connect uses A (or explicitly refuses if revoked), reservation/actual evidence agree, and B receives no call content.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/calls/dial.ts#L67-L99), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/calls/module.ts#L91-L103), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/calls/finish.ts#L76-L87), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/calls/finish.ts#L41-L112), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/calls/module.ts#L134-L164), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/calls/dial.ts#L53-L103)

### MC-02: Terminal call status commits before durable result delivery, preventing retry

**Current status:** Partial; source changes and focused checks.

**Observed condition:** process crash or persistence error after calls.finish but before recordCallResult completes. The next finish sees a terminal session and exits, while stale sweep skips it.

**Required improvement:** terminal session transaction should persist deterministic cost/result outbox records; replay their delivery independently and idempotently until acknowledged. Retain completed-call data and avoid re-dialing. Proposed tests: fault each boundary after finish/before cost/before callback and restart, concurrent bridge/status/sweep finish, callback already consumed, and metering outage. Assert one call, one settled cost, and eventually one task wake.

**Acceptance to establish:** fault each boundary after finish/before cost/before callback and restart, concurrent bridge/status/sweep finish, callback already consumed, and metering outage. Assert one call, one settled cost, and eventually one task wake.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/calls/finish.ts#L41-L112), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/calls/bridge.ts#L385-L427), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/calls/module.ts#L134-L164), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/calls/module.ts#L91-L103), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/calls/finish.ts#L76-L87)

### MC-10: A skipped channel send is treated as a completed delivery attempt

**Current status:** Partial; source changes and focused checks.

**Observed condition:** an owner channel task/follow-up reaches finalization with no valid deliverable target, or email-origin adhoc continuation has unavailable Google client (assertDeliverable only checks email_triage). No external provider acceptance occurred, yet no exception/result distinguishes it.

**Required improvement:** typed per-leg outcome {not_applicable, accepted, rejected, unknown}; required channel with no valid target must remain delivery-blocked. Persist provider attempt identity and ambiguous status separately. Never solve this by retrying genuinely ambiguous accepted sends.

**Acceptance to establish:** email-origin adhoc missing client, missing binding, revoked owner address/domain, SMS owner phone change, definite provider reject, ambiguous transport and dashboard-only task. Verify channel-specific final state and no unintended cross-recipient send.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-channel.ts#L113-L143), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/module.ts#L200-L219), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/sms/channel.ts#L220-L236), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L186-L232), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/module.ts#L109-L124), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/module.ts#L126-L186), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/sms/channel.ts#L66-L121), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/sms/channel.ts#L220-L262)

### MC-12: Outbound call concurrency/day limits are check-then-create

**Current status:** Partial; source changes and focused checks.

**Observed condition:** two authorized startCall operations for the same owner begin concurrently with enough model/line budget and the same available call slot/day capacity.

**Required improvement:** atomic owner-scoped capacity reservation/session admission (transaction/CAS), counting admitted/ambiguous calls conservatively, with idempotent release on definite failure. Do not use a global mutex that fails across instances.

**Acceptance to establish:** concurrent distinct task calls with one slot/day call remaining, process crash after admission, ambiguous dial and stale cleanup. Assert at most one placeCall in both adapters.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/calls/dial.ts#L53-L103), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/call-session-repository.ts#L24-L60), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/call-sessions.ts#L58-L132), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/schema.ts#L571-L616), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/calls/dial.ts#L67-L99)

### PG-01: Cancelling a watch can be undone by an in-flight fire

**Current status:** Partial; source changes and focused checks.

**Observed condition:** concurrent cancellation/expiry and a matching event. Impact: unwanted future monitoring or notifications after cancellation, and violation of the owner’s stop instruction. Exact downstream delivery effects remain cross-partition validation; state resurrection alone is proven statically.

**Required improvement:** serialize all watch state transitions through the same row lock (or advisory lock) and use expected-status/claim predicates on the final mutation. Do not insert a fire once cancellation wins. Test: barrier after recordFire read; commit cancel; release fire; assert cancelled stays cancelled, no actionable new fire is committed, and retries remain inert. Also test expiry and overlapping web poll claim.

**Acceptance to establish:** barrier after recordFire read; commit cancel; release fire; assert cancelled stays cancelled, no actionable new fire is committed, and retries remain inert. Also test expiry and overlapping web poll claim.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/watch-repository.ts#L52-L66), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/watch-repository.ts#L144-L193)

### PG-03: Primary-chat fallback can adopt the assistant-only Notifications thread

**Current status:** Partial; source changes and focused checks.

**Observed condition:** fresh/legacy primary initialization after background notification created a chat. Fix: dedicated stable conversation purpose/identity, only owner-chat fallback candidates, owner-scoped serialization, and migration repair. Test: Notifications is newest before first primary initialization; owner interaction still targets an owner-trust primary and commitments extract. Overall product finding should be merged with memory report, not counted twice.

**Required improvement:** dedicated stable conversation purpose/identity, only owner-chat fallback candidates, owner-scoped serialization, and migration repair. Test: Notifications is newest before first primary initialization; owner interaction still targets an owner-trust primary and commitments extract. Overall product finding should be merged with memory report, not counted twice.

**Acceptance to establish:** Notifications is newest before first primary initialization; owner interaction still targets an owner-trust primary and commitments extract. Overall product finding should be merged with memory report, not counted twice.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/application-chat-repository.ts#L88-L133), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/notifications-conversation-repository.ts#L16-L35), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/application-chat-repository.ts#L682-L704), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/application-chat.ts#L112-L207), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/application-chat.ts#L664-L683)

### PG-06: First concurrent SMS messages can split into a conversation with no return route

**Current status:** Partial; source changes and focused checks.

**Observed condition:** PG-06: First concurrent SMS messages can split into a conversation with no return route (high confidence, new trigger of channels MC-10)

**Required improvement:** serialize peer binding creation or insert unique binding transactionally and read the winning conversation; remove unused loser and verify owner identity. Make delivery return a typed sent/skipped/failed result. Test two concurrent first messages with different SIDs for one peer; both must bind to the same conversation and produce routed receipts. Merge delivery part with channels MC-10.

**Acceptance to establish:** Deliver two distinct first inbound SMS events for the same peer concurrently. Both bind to the same owner conversation and return valid routed receipts; no losing orphan conversation is used.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/sms-channel-repository.ts#L37-L52), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/sms-channel-repository.ts#L54-L73)

### PG-08: Self-repair claiming can overwrite an owner dismissal

**Current status:** Partial; source changes and focused checks.

**Observed condition:** owner dismissal racing a scheduled claim. Impact: repair work can begin after accepted dismissal, potentially spending resources and progressing a workflow the owner stopped; actual external changes remain bounded by later workflow guards. Fix row lock plus expected issue version/status on claim, or one shared mutation lock. Proposed barrier test: pause claim after candidate read, dismiss successfully, resume claim; it must return no claim and preserve dismissal.

**Required improvement:** Make self-repair claim conditional on the same live issue version/status observed by the claimant, or use the shared row lock. Accepted owner dismissal must win over stale automated work.

**Acceptance to establish:** pause claim after candidate read, dismiss successfully, resume claim; it must return no claim and preserve dismissal.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/self-repair-repository.ts#L64-L89), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/self-repair-repository.ts#L91-L104), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/self-repair.ts#L63-L102)

### PG-09: Microsecond reply cursors can repeatedly re-inject prior owner messages on resume

**Current status:** Partial; source changes and focused checks.

**Observed condition:** PG-09: Microsecond reply cursors can repeatedly re-inject prior owner messages on resume (high confidence, new)

**Required improvement:** preserve exact timestamp text or an opaque adapter cursor through the shared interface and task checkpoint (as application chat already does), and compare a stable timestamp/id tuple. Filtering only the last ID is insufficient for multiple messages in one millisecond. Tests: default-now and explicit .123456/.123789 timestamps, repeated resume and first baseline, same-millisecond IDs, and PostgreSQL/Firestore parity. Current repository test148–197 and runtime reply-fold.test.ts66–117 deliberately insert millisecond-aligned Date fixtures, so their idempotence assertions miss the actual storage precision. Statically established; no tests run.

**Acceptance to establish:** default-now and explicit .123456/.123789 timestamps, repeated resume and first baseline, same-millisecond IDs, and PostgreSQL/Firestore parity. Current repository test148–197 and runtime reply-fold.test.ts66–117 deliberately insert millisecond-aligned Date fixtures, so their idempotence assertions miss the actual storage precision. Statically established; no tests run.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/execution-context-repository.ts#L73-L108), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/persistence/src/execution-context.ts#L3-L5), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/seed.ts#L172-L208), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/schema.ts#L234-L254), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/schema.ts#L1096-L1099), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/schema.ts#L483-L486), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/workspace-migration.ts#L73-L81), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/store.ts#L54-L58), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/execution-context.ts#L130-L168), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/workspace-migration.ts#L519-L533), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/workspace-migration.ts#L655-L675)

### R1: Multi-call suspension loses earlier approvals and leaves an invalid transcript

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The executor appends every tool call from a model batch at step-loop.ts:1122–1135, then accumulates approvals in a local array at 1137 and1249–1264. That array enters the durable task state only after the entire loop, through 1294–1300.

**Required improvement:** persist an ordered per-call batch journal before dispatch. Every exit must carry already-created approvals, launched jobs, completed receipts, and undispatched calls. Use one continuation builder for ordinary checkpoint, budget park, browser prelaunch, approval park, and failure. Resume from the durable batch journal, not a regenerated model batch.

**Acceptance to establish:** all permutations of executed/approval/budget/job results in a three-call batch; crash after each mutation/checkpoint; approval resolve before/after budget reset; assert exact once effect identities, all unresolved approvals retained, and one terminal result per emitted call before the next model request. Existing golden harness explicitly cannot exercise approvals (harness.ts:132–184); tool-context.test.ts tests only address harvesting, not staging.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1122-L1135), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1137-L1264), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1294-L1300), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1223-L1248), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/tool-context.ts#L138-L148), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L236-L243), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/golden/harness.ts#L132-L184), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1393-L1400)

### R10: Compound SMS sends remain incomplete after real successful sends

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The checklist's send proof accepts only nonempty result.messageId or result.id (request-checklist.ts:160–170). The channels reviewer fully inspected the actual pinned SMS implementation and confirmed packages/tools/src/twilio/sms.ts:77–80 returns {sid: result.sid, to: args.to}. Thus a compound request that otherwise matches its target terms can successfully send an SMS but retain a blocked checklist item. Finalization replaces the success response with needs_attention (R8's shared funnel). The single-send golden fixture uses sid but bypasses the compound checklist, so it does not catch this contract mismatch.

**Required improvement:** typed common communication receipt with provider message identity, accepted/unknown/rejected state and exact recipient/action correlation. Bridge each provider adapter into it; avoid an expanding list of guesses in separate output surfaces.

**Acceptance to establish:** two authorized SMS sends in one request, mixed email+SMS, accepted sid, rejected/ambiguous provider result, partial success and retry. Assert accepted SMS satisfies exactly its matching outcome and never prompts a duplicate resend. Test through the actual dispatcher and adapter contract, not a fictional messageId return stub.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/request-checklist.ts#L160-L170), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/twilio/sms.ts#L77-L80)

### R13: Calendar projections can merge distinct recurring occurrences and hide real conflicts

**Current status:** Partial; source changes and focused checks.

**Observed condition:** a rescheduled weekly occurrence overlaps a sibling instance on the same calendar. Both retain the series iCalUID. The union operation merges them and the conflict disappears. The existing test expressly intended to protect this case (briefing.test.ts:456–484) omits iCalUID, so it exercises only the later guard. Across-calendar recurringEventId equality also proves a series, not an occurrence.

**Required improvement:** share an occurrence-identity function across conflict detection, cards and read summaries. Treat (calendarId,eventId) as row identity; cross-calendar equivalence needs iCalUID plus originalStartTime or demonstrably matching single-event identity. Heuristics must never erase same-calendar distinct IDs; uncertain duplicates should remain or be visibly grouped without hiding times.

**Acceptance to establish:** realistic provider fixtures with equal iCalUID/different event IDs and originalStartTime, moved occurrences, true cross-calendar copies, coincident unrelated same-title entries, and transitive duplicate groups. Preserve two separate commitments and their conflict.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L348-L373), [reference 2](https://developers.google.com/workspace/calendar/api/v3/reference/events), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.test.ts#L456-L484), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-cards.ts#L100-L105)

### R14: Watch suggestion recovery depends on the model repeating its earlier decision

**Current status:** Partial; source changes and focused checks.

**Observed condition:** commit succeeds, process dies before append. On retry the model returns worthSuggesting:false, empty text, or an unparseable object. The job returns benignly without posting the already-committed suggestion. This disproves the source comment's claim that a crash between the writes necessarily converges on one card. A rejected/expired/deleted watch context can likewise skip a committed unsent proposal unless the repository/outbox explicitly reconciles it.

**Required improvement:** query and reuse a durable prepared suggestion before model invocation; atomically commit proposal and message intent, then deliver independently using a stable key. Once prepared, replay must not depend on nondeterministic recomposition.

**Acceptance to establish:** crash after commit before append; changed model verdict, model timeout/unparseable/budget block on retry; accepted/dismissed proposal before delivery; concurrent retry. Existing redelivery test127–140 always returns the same GOOD_DRAFT and checks duplicate prevention only.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/watch-suggest.ts#L85-L115), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/watch-suggest.ts#L121-L129), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/watch-suggest.ts#L131-L149)

### R3: Mission outcomes and alerts lack durable report delivery intent

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Mission deadline and reflection completion/abandonment commit terminal state before report() (missions.ts:143–154,320–337, terminal reflection). Report awaits chat persistence before attempting owner notification (351–371). Failure or process death after terminal commit loses the final notice; ordinary task retries cannot reclaim done/cancelled. Unlike normal finalization, this path does not stage a durable pendingFinal/outbox.

**Required improvement:** transactional notification outbox with stable event ID, expiring claim lease, separate deliveredAt, independent delivery legs, and read repair. Mission terminal transition and final report intent should commit together. Do not use lastNotifiedAt as an in-progress claim.

**Acceptance to establish:** kill after state/alert commit and before append, throw append, accept append then kill before stamp, concurrent sweeps, fail owner leg while chat leg works. Assert eventual one durable owner message. Existing mission deadline fixture checks done with no conversation and never asserts delivery; health concurrency fixture verifies duplicate prevention but not process-death recovery.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/missions.ts#L143-L154), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/missions.ts#L320-L337), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/missions.ts#L351-L371), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/health-monitor.ts#L69-L108), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/health-monitor.ts#L251-L278), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/anomaly.ts#L219-L239), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/missions.ts#L280-L338)

### R4: Stalled-goal replacement can cancel a newly resumed task

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Synthetic interleaving: sweep reads taskT as stalled → owner retriesT → worker claimsT → sweep cancelsT based on old snapshot → replacement occurrence is created. The owner's explicit continuation is invalidated, and external work already begun may overlap a replacement. If occurrence commit subsequently rejects its schedule snapshot, cancellation can happen with no replacement at all.

**Required improvement:** atomically prepare/supersede/commit occurrence under goal/task/schedule revision guards; cancellation only when task remains the exact stalled version, otherwise recompute gate. Preserve owner intent version and active work exclusion.

**Acceptance to establish:** barriers between read/cancel/commit with owner wake, approved effect resume, schedule disable, goal archive and concurrent sweeper. Existing schedule tests cover sequential replacement only.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/schedules.ts#L584-L599), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/machine.ts#L180-L196), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/task-lifecycle-repository.ts#L168-L191)

### R5: Invalid autonomy expiration fails open

**Current status:** Partial; source changes and focused checks.

**Observed condition:** autonomy.ts:22–27 accepts timestamps as arbitrary strings. 85–91 rejects only new Date(expiresAt).getTime() <= nowMs; invalid dates yield NaN and pass. A malformed owner/assistant grant can remain active indefinitely. Normal builder produces valid ISO dates, so this is not a demonstrated remote exploit.

**Required improvement:** schema-level datetime validation plus finite timestamps, allowed TTL, grantedAt <= now < expiresAt, and valid grant provenance. Fail closed on any malformed persisted value.

**Acceptance to establish:** empty/invalid expiry, infinity-like strings, future grant time, reversed interval, exact expiry, invalid now, revoked variants. Existing tests cover well-formed expiry/revocation only.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/autonomy.ts#L22-L27), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/autonomy.ts#L85-L91)

### R6: Retention can erase live task execution evidence

**Current status:** Partial; source changes and focused checks.

**Observed condition:** maintenance.ts:249–284 prunes aged tool rows if not referenced by approvals/cost events, without requiring the owning task to be terminal. Live checkpoints still depend on these rows for result retrieval, request completion, goal progress, and dispatcher idempotency. A long-lived sleeping/waiting-budget/needs-attention task can outlive retention and lose its prior nonbillable autonomous-effect evidence. Defaults keep forever, narrowing exposure to deployments that enable history retention. PostgreSQL tool execution relies on the surviving tool-call row for its idempotency key (tool-execution-repository.ts172–206, independently read by persistence reviewer); task JSON checkpoints do not provide a foreign-key protection. The schema also cascades tool-call deletion into call sessions (schema.ts581–583), so an unprotected aged row can remove its call transcript/outcome.

**Required improvement:** retain execution receipts and idempotency records while any task/child/pending final references them, independent of user-visible history retention. Store minimal effect identity/receipt separately from private payload retention. Terminal plus safe replay horizon should govern purge.

**Acceptance to establish:** age a parked live task's successful reminder/calendar/write receipt and pending-job row; purge then resume; assert evidence/fence survives and no duplicated effect. Test adapter parity and dangling checkpoint references.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/maintenance.ts#L249-L284), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/maintenance.test.ts#L238-L303), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/maintenance.test.ts#L34-L118), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/maintenance.test.ts#L180-L290)

### R8: Checklist cannot represent owner-cancelled outcomes

**Current status:** Partial; source changes and focused checks.

**Observed condition:** “Find my hotel and remind me,” then “Cancel the reminder portion; keep the lookup.” Runtime can correctly avoid reminder creation yet still claim the cancelled outcome remains outstanding, replacing the useful answer with a failure. Existing golden correction test (228–286) asserts tool list/recovery count but not final status or cancelled-scope truth.

**Required improvement:** versioned obligation set with explicit superseded/cancelled states, changed only from authenticated current owner instruction and bound to exact original outcome. Reconcile against current scope; retain audit history of old scope.

**Acceptance to establish:** cancellation of one part, replacement recipient/date, topic change without cancellation, old task racing new task, cancelled outcome already executed, ambiguous cancellation requiring clarification.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/request-checklist-schema.ts#L26), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1393-L1400), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L278-L291), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/golden/golden.e2e.test.ts#L228-L286), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1122-L1135), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1137-L1264), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1294-L1300), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1223-L1248), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L200-L232), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L867-L876)

### TW-04: Repeated jobs reuse earlier artifact identities

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Two sequential code runs in the same task emit the same file name, or two browser plans use the same screenshot position/name. When the storage identity can replace objects (including the local store and deployed browser objectUser), old receipts resolve to newer bytes. The deployed code object's creator-only permission instead rejects replacement of an existing object, turning the collision into a failed later run. Neither outcome preserves the intended two distinct artifacts

**Required improvement:** Immutable execution-scoped object paths plus content hashes and versioned artifact receipts. Reuse identity only for verified replay of the same logical run

**Acceptance to establish:** Two executions in one task with identical names and different bytes; both receipts retain correct contents; retries deduplicate; failed later run cannot replace prior artifact

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L132-L140), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/browser-job/src/steps.ts#L117-L122), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L161-L183), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L111-L119), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L97-L119)

### VH-04: Call transcript flushing can discard unpersisted batches

**Current status:** Partial; source changes and focused checks.

**Observed condition:** flushTranscript removes buffered rows before awaiting persistence and only logs a write failure. Lost persistence can leave the call evidence incomplete.

**Required improvement:** Use sequenced idempotent transcript batches with durable acknowledgment/retry and explicit gap markers. Bind check-ins to exact offer/payload revision, expiry and delivered/answered state.

**Acceptance to establish:** Fail transcript writes, restart after buffer removal, duplicate/reorder batches and answer a superseded check-in. Preserve one ordered transcript or explicit gap; a late answer must not authorize another offer.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/calls/bridge.ts#L225-L308)

### FS-14: Asynchronous learned-memory and voice writers can cross successful privacy erasure

**Current status:** Partial; source changes and focused checks.

**Observed condition:** FS-14: Asynchronous learned-memory and voice writers can cross successful privacy erasure (high severity, high confidence, new specific schedules related to PG-05)

**Required improvement:** capture an owner erasure generation before source observation and require exact equality at every derived publication; fence/cancel active learning tasks; route auto voice writes through the same guarded repository. Pulse already implements the observation-generation pattern at pulse.ts294–319. Proposed tests: pause extract/embed after source read, finish erasure, resume writer; pause voice capture across final sample deletion; verify no pre-erasure derivative is inserted or returned. Firestore's compiler and same-hash save/forget transactions are stronger than PostgreSQL's separate-check paths and are not falsely included in this finding.

**Acceptance to establish:** pause extract/embed after source read, finish erasure, resume writer; pause voice capture across final sample deletion; verify no pre-erasure derivative is inserted or returned. Firestore's compiler and same-hash save/forget transactions are stronger than PostgreSQL's separate-check paths and are not falsely included in this finding.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/privacy-erasure.ts#L21-L60), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/privacy-erasure.ts#L392-L445), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L415-L482), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L90-L97), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/voice.ts#L23-L48), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/voice-context.ts#L96-L115), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/pulse.ts#L294-L319), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L517-L595), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L368-L453)

### HM03: Document erasure acknowledges success after losing retryable blob work

**Current status:** Partial; source changes and focused checks.

**Observed condition:** HM03 · P1 privacy/reliability · Document erasure acknowledges success after losing retryable blob work

**Required improvement:** durable owner-scoped deletion manifest/outbox retaining all blob identities until verified deleted; retriable failures; safe user-facing distinction between logical hiding and completed erasure. Preserve privacy fences against in-flight extraction/processor callbacks. Do not leak storage paths in public error text.

**Acceptance to establish:** fail original or derived blob deletion, restart, retry erasure, verify both objects are gone before final completion; absent workspace must remain pending; concurrent callback/extraction may not recreate content.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/document-catalog.ts#L243-L291), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/document-deletion.ts#L40-L103)

### HM05: Import deletion does not erase derived archive content or occasions

**Current status:** Partial; source changes and focused checks.

**Observed condition:** import.ts 128–160 writes complete parsed archive windows under .assistant/imports/<source>/<task>/...; they contain raw message text, not merely distilled facts. deleteImportSource 1073–1110 deletes source-tagged memories, original uploaded path and source row only. It never deletes the manifest or shards. purgeImportSource 1029–1065 similarly deletes only memories.source. Imported occasions are saved separately with source:payload.source (639–660), and neither purge deletes them. Consolidation creates derived facts without preserving the source tag (consolidation.ts 538–555), so those descendants also survive source-only deletion. A successful “delete import” therefore leaves source-derived birthday reminders, raw archived text snapshots and potentially rewritten memories.

**Required improvement:** explicit source/derivation graph for memories, occasions, graph projections, compiled cards and raw/parsed blobs. Define purge-versus-delete semantics clearly, capture all descendants before deleting lineage, retain an erasure outbox until physical completion, and block in-flight repopulation. Do not use exact text hashes as the only lineage/suppression boundary.

**Acceptance to establish:** import source with facts+occasions, consolidate two facts, create snapshot shards, delete source, then read every projection and workspace path and attempt resumed job writes. No erased content may remain recallable or orphaned; a partial physical erase must report pending rather than complete.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/import.ts#L128-L160), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/import.ts#L1029-L1110), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/import.ts#L639-L660), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/consolidation.ts#L538-L555), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/consolidation.ts#L352-L357), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/consolidation.ts#L433-L452), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/consolidation.ts#L125-L131), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/consolidation.ts#L207-L220), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/import.ts#L603-L625), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/import.ts#L838-L852)

### HM06: Untrusted occasion updates inherit an already-trusted row

**Current status:** Partial; source changes and focused checks.

**Observed condition:** email-extraction.ts 176–190 stores occasions from unknown email with quarantined:true. occasions.ts 274–290 nevertheless fills a missing year and appends any new notes on an existing identity, while leaving that existing row's trust/quarantine unchanged. A reviewed birthday followed by unknown email about the same contact/date absorbs the email's year/gift instructions into a non-quarantined record. upcomingOccasions 162–179 filters only the aggregate row's quarantine, so new unreviewed content becomes visible immediately. Extraction/import/consolidation share this SQL writer. Firestore extraction 434–452 has the same year/notes mutation while preserving row trust. Its separate consolidation writer does protect owner-confirmed/owner-origin occasions (413–415), illustrating an adapter/writer policy divergence rather than a universal protection.

**Required improvement:** provenance and approval per field/claim; keep untrusted additions as separate reviewable observations, or permit only same-or-higher trust updates. Do not silently downgrade an accepted row, but also do not launder new lower-trust content through it. Apply consistently to Firestore writers.

**Acceptance to establish:** trusted birthday with blank year and notes, then unknown email containing new year and arbitrary notes. Require no unreviewed additions in live occasion presentation; an owner-confirmed change may update it. Include input with same date but different custom label.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/email-extraction.ts#L176-L190), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/occasions.ts#L274-L290), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L434-L452), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-consolidation.ts#L402-L423), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L517-L595), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-consolidation.ts#L317-L343), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-consolidation.ts#L224-L233), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-consolidation.ts#L357-L367), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L368-L453), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L90-L97)

### HM21: Transient location is copied into durable task instructions

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Synthetic regression, not run: enqueue an arrival, expire its source observation, then inspect tasks, events, audit records and learnable transcripts for coordinates/identifiable venue history. Require retention-compatible redaction while preserving a non-identifying dedupe mechanism.

**Required improvement:** pass an ephemeral observation reference with enforced expiry, resolve it only when needed, redact precise coordinates from durable identifiers/instructions/audit payloads, and make location retention apply to every derivative. Product consent/retention text must accurately describe what remains. Avoid retaining a full location trail merely to dedupe arrival notices.

**Acceptance to establish:** enqueue an arrival, expire its source observation, then inspect tasks, events, audit records and learnable transcripts for coordinates/identifiable venue history. Require retention-compatible redaction while preserving a non-identifying dedupe mechanism.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/location.ts#L13-L16), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/location.ts#L137-L151), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/arrival.ts#L136-L162)

### PG-05: Privacy erasure can lose to an in-flight card compilation or memory save

**Current status:** Partial; source changes and focused checks.

**Observed condition:** concurrent compilation/save and owner erasure/forget. No shared-database/multiple-owner precondition. Impact: deleted information can survive in compiled prompts or reappear in recall after successful erasure. Fix: all privacy-sensitive writers take the same owner/generation boundary before source/tombstone reads and verify an observation generation at commit; compiler must coordinate with erase and validate its source generation. Add tombstone exclusion as defense in depth. Tests: deterministic barrier after card-source read and after final tombstone check; commit erasure/forget; resume stale writer; assert no old card or recalled row. Current privacy-erasure-repository.test.ts tests sequential erasure and assets, memory-tool-repository.test.ts tests preexisting tombstones, neither tests these races.

**Required improvement:** all privacy-sensitive writers take the same owner/generation boundary before source/tombstone reads and verify an observation generation at commit; compiler must coordinate with erase and validate its source generation. Add tombstone exclusion as defense in depth. Tests: deterministic barrier after card-source read and after final tombstone check; commit erasure/forget; resume stale writer; assert no old card or recalled row. Current privacy-erasure-repository.test.ts tests sequential erasure and assets, memory-tool-repository.test.ts tests preexisting tombstones, neither tests these races.

**Acceptance to establish:** deterministic barrier after card-source read and after final tombstone check; commit erasure/forget; resume stale writer; assert no old card or recalled row. Current privacy-erasure-repository.test.ts tests sequential erasure and assets, memory-tool-repository.test.ts tests preexisting tombstones, neither tests these races.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/privacy-erasure-repository.ts#L71-L98), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/privacy-erasure-repository.ts#L181-L205), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/owner-card-compilation-repository.ts#L18-L137), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/memory-tool-repository.ts#L51-L102), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/memory-tool-repository.ts#L154-L162), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/memory-tool-repository.ts#L56-L61)

### APP-07: Relationship correction is split, and the old fact remains recallable

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Relationship correction is split, and the old fact remains recallable

**Required improvement:** durable correction operation referencing old relation, source memory/version and replacement. Prepare embedding before transactional replacement/retirement; define source disposition explicitly (do not erase unrelated claims in a multi-claim memory). Report partial outcome honestly and make replay finish it. Regression: fail at each boundary, concurrent source edit, duplicate replacement, graph-only correction versus whole-fact correction, and verify both graph and raw-memory retrieval after correction.

**Acceptance to establish:** fail at each boundary, concurrent source edit, duplicate replacement, graph-only correction versus whole-fact correction, and verify both graph and raw-memory retrieval after correction.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/knowledge-graph.ts#L1118-L1173)

### AUX-AUDIT-PRIVACY: Audit redaction is not anonymization and needs URL/field-aware handling

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Pattern redaction can leave query-only URL secrets or arbitrary secret-valued fields; redacted capture remains private and may be used in model-assisted investigation.

**Required improvement:** Use source-minimizing, URL/field-aware redaction and explicit data-use/retention contracts; preserve owner scoping and untrusted evidence labeling.

**Acceptance to establish:** Synthetic query credentials, nested secret fields, full/redacted/off modes and model-assisted reads do not leak prohibited data; unknown retention/export limitations remain disclosed.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/sports/espn.ts#L93-L102), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/sports/lookup.ts#L139-L188), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/maps/apple.ts#L97-L105), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/realtime-voice/openai.ts#L110-L133), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/realtime-voice/gemini.ts#L259-L275), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/audit-capture.ts#L26-L65), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/audit-graders.ts#L369-L389), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/calendar-module.ts#L11-L23), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/application-confirmations.ts#L530-L570)

### DM-07: Audit capture is described as never reused in prompts although tools expose it to the assistant

**Current status:** Partial; source changes and focused checks.

**Observed condition:** An owner enables capture believing the stated review-only/no-model-use promise, then investigates a task through the assistant. Captured private material can become tool context sent to the configured model provider. Redacted capture is pattern-based and explicitly not anonymous; full capture is more sensitive. The false categorical guarantee obscures this data-use boundary.

**Required improvement:** describe both local/manual auditing and model-assisted investigation, exact data categories, truncation, credential exclusion and retention. Keep confidential-read/taint controls and narrow owner/task scoping. If a no-provider diagnostic mode is a product promise, enforce it structurally rather than in prose; add an explicit source-minimizing investigation projection.

**Acceptance to establish:** captured credential-like fields, private text, full/redacted/off modes, owner vs external task registry, bounded field continuations, provider-context capture with synthetic records, erasure/retention and stale cached investigations. Assert what leaves the installation, not just what the UI masks.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/llm-output-review.md#L25-L43), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/audit-investigations.md#L3-L9), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/builtin/audit.ts#L10-L36), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/builtin/audit.ts#L40-L71)

### FS-05: Prior-conversation evidence window is not actually the newest tool receipts

**Current status:** Partial; source changes and focused checks.

**Observed condition:** execution-evidence.ts113–169 sorts prior tasks by task.createdAt, then queries each task's tool calls with limit(max) but no createdAt ordering, and only sorts that arbitrary document-ID-selected subset afterward. A task with more than max calls can exclude its latest steps entirely. An older long-running task that completes after a newer task can also be skipped because the window is filled in task-start order. This contradicts the stated most-recent tool-call evidence contract and can make a subsequent answer use stale state or omit a recent success/failure receipt. Fix: query by conversation/owner with a denormalized indexed receipt timestamp and stable tie ID, or perform ordered per-task windows and a global top-K merge. Test: one prior task with max+1 calls whose newest call sorts beyond the default document-ID limit, and two tasks whose creation order differs from receipt completion order. Existing test296–324 aligns task creation and call times and cannot catch this.

**Required improvement:** query by conversation/owner with a denormalized indexed receipt timestamp and stable tie ID, or perform ordered per-task windows and a global top-K merge. Test: one prior task with max+1 calls whose newest call sorts beyond the default document-ID limit, and two tasks whose creation order differs from receipt completion order. Existing test296–324 aligns task creation and call times and cannot catch this.

**Acceptance to establish:** one prior task with max+1 calls whose newest call sorts beyond the default document-ID limit, and two tasks whose creation order differs from receipt completion order. Existing test296–324 aligns task creation and call times and cannot catch this.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/execution-evidence.ts#L113-L178)

### FS-07: Message embedding cursor permanently skips backfilled history and embedding-space changes

**Current status:** Partial; source changes and focused checks.

**Observed condition:** maintenance.ts193–217 uses one durable installation-wide creation-time cursor (message-embedding-cursor) and never resets it or keys it by embedding space. Existing messages inserted/backfilled behind that cursor will never be considered. Changing the embedding provider/model/revision also leaves earlier messages behind the cursor, despite the eligibility condition accepting foreign-space vectors. History and conversation semantic retrieval require the current exact embeddingSpace, so old conversation memory silently disappears after a model-space change and late-imported history remains unsearchable. Fix: space-versioned migration/checkpoint state, resumable full backfill, explicit late-write/indexing intents or modification sequence rather than a creation-time-only cursor. Test complete an initial pass, switch to a compatible new space revision, and insert an older message; both must eventually receive current-space vectors without replaying all paid work unnecessarily. Existing tests only seed foreign-space messages before the first cursor is established.

**Required improvement:** space-versioned migration/checkpoint state, resumable full backfill, explicit late-write/indexing intents or modification sequence rather than a creation-time-only cursor. Test complete an initial pass, switch to a compatible new space revision, and insert an older message; both must eventually receive current-space vectors without replaying all paid work unnecessarily. Existing tests only seed foreign-space messages before the first cursor is established.

**Acceptance to establish:** Finish embedding pass, insert older/backfilled messages, then change embedding-space revision. All eligible messages eventually receive the exact current space through resumable work without duplicate paid preparation.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/maintenance.ts#L193-L264)

### FS-08: Commitment history eventually disables extraction for an otherwise valid recurring fact

**Current status:** Partial; source changes and focused checks.

**Observed condition:** memory-extraction.ts517–530 queries all rows sharing a content hash, limits at11, throws if more than10, and only then filters open/snoozed status. Resolved/dismissed/stale history therefore counts against a limit described as active twins. Repeated extraction recreates a closed commitment558–595; after enough close/re-extract cycles, this valid historical data deterministically causes the entire batch to fail, including unrelated new commitments and resolutions. Fix: occurrence/source-aware recurrence policy that respects owner dismissal, query active twins before the bound and separate append-only history. Test11 closed same-hash rows plus one new valid item; extraction must remain available and must not resurrect a dismissed occurrence. Also align commitment correction duplicate check (commitment-mutations135–148), which reads first10 before active filtering and can miss an active duplicate beyond them.

**Required improvement:** occurrence/source-aware recurrence policy that respects owner dismissal, query active twins before the bound and separate append-only history. Test11 closed same-hash rows plus one new valid item; extraction must remain available and must not resurrect a dismissed occurrence. Also align commitment correction duplicate check (commitment-mutations135–148), which reads first10 before active filtering and can miss an active duplicate beyond them.

**Acceptance to establish:** Seed eleven closed same-hash commitments plus an unrelated valid new commitment. Extraction remains available, does not resurrect the closed occurrence, and does not count lifetime history as active twins.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L517-L595), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L368-L453), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L90-L97)

### FS-10: Editing an occasion's date breaks the deterministic identity used by other writers

**Current status:** Partial; source changes and focused checks.

**Observed condition:** profile-occasion-command.ts258–269 changes kind/month/day in place while retaining a document ID derived from the original owner/person/kind/month/day37–46. After Apr12→Apr13, a later record of Apr12 computes the occupied old ID and rejects it as malformed153–156. The general extraction writer instead attempts to create that occupied old ID; consolidation validates original date against the new row and rejects the whole review. Import's keyed upsert only checks owner/contact (imports585–587), so an Apr12 input can enrich the now-Apr13 row. Existing test193–211 verifies immediate edit but not later ingestion. Person merge also changes occasion.contactId in place without moving its source-contact-derived ID, another route to the same disagreement. Fix: immutable occasion identity with a separate atomic unique-date marker, or move/alias deterministic IDs on edits consistently across all writers. Test edit then record both dates through owner, tools, email/extraction, import and consolidation; preserve explicit owner correction and avoid blocked unrelated batch work.

**Required improvement:** immutable occasion identity with a separate atomic unique-date marker, or move/alias deterministic IDs on edits consistently across all writers. Test edit then record both dates through owner, tools, email/extraction, import and consolidation; preserve explicit owner correction and avoid blocked unrelated batch work.

**Acceptance to establish:** Edit an occasion date or merge its person, then ingest both old and new dates through every writer. Preserve the owner correction, consistent identity markers and availability of unrelated batch work.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/profile-occasion-command.ts#L148-L180)

### FS-11: Deleting an auto-created person leaves a stale name identity that future learning trusts

**Current status:** Partial; source changes and focused checks.

**Observed condition:** automatic person creation, owner deletion, then subsequent extraction mentioning the same name; no concurrent race or corrupted input is needed. Fix: atomically maintain all reverse name markers during deletion/merge, validate marker targets and owner on lookup, and fence in-flight subject writes against removal. Proposed tests: auto-create -> delete -> relearn; auto-create -> merge -> alias change -> relearn, and deterministic removal versus pending extraction races. If forgetting a person should prevent relearning, retain an explicit identity tombstone rather than an invalid pointer.

**Required improvement:** atomically maintain all reverse name markers during deletion/merge, validate marker targets and owner on lookup, and fence in-flight subject writes against removal. Proposed tests: auto-create -> delete -> relearn; auto-create -> merge -> alias change -> relearn, and deterministic removal versus pending extraction races. If forgetting a person should prevent relearning, retain an explicit identity tombstone rather than an invalid pointer.

**Acceptance to establish:** auto-create -> delete -> relearn; auto-create -> merge -> alias change -> relearn, and deterministic removal versus pending extraction races. If forgetting a person should prevent relearning, retain an explicit identity tombstone rather than an invalid pointer.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/contact-lookup.ts#L108-L120)

### FS-16: Entity merge deletes an owner's rejection in favor of an unreviewed duplicate

**Current status:** Partial; source changes and focused checks.

**Observed condition:** knowledge-graph-curation.ts281–322 promises to preserve owner review state, but ranks confirmed first, unreviewed second, and rejected last. After re-pointing two entity identities, relations with the same subject/predicate/object/sourceMemoryId collapse to one; an unreviewed duplicate wins over an explicitly rejected relation, which is hard-deleted338. A legitimate owner merge can therefore erase the review decision and leave the same source assertion eligible again. The condition is duplicate endpoint identities for the same source plus one rejected and one unreviewed relation; not every merge is affected. Confirmed-versus-rejected conflicts also need an explicit product rule rather than incidental rank.

**Required improvement:** preserve review lineage and apply a conservative owner-decision conflict policy; an unreviewed duplicate must not supersede a rejection. Proposed tests: rejected/unreviewed duplicates in both source/target directions, confirmed/rejected conflicts, same relation from different sources, and repeat merge; assert review history and recall eligibility are preserved.

**Acceptance to establish:** rejected/unreviewed duplicates in both source/target directions, confirmed/rejected conflicts, same relation from different sources, and repeat merge; assert review history and recall eligibility are preserved.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/knowledge-graph-curation.ts#L281-L344)

### FS-17: Knowledge workspace reports relations as in recall when runtime necessarily rejects them

**Current status:** Partial; source changes and focused checks.

**Observed condition:** FS-17: Knowledge workspace reports relations as in recall when runtime necessarily rejects them (medium severity, high confidence, new projection mismatch)

**Required improvement:** shared eligibility specification including current embedding space/retrieval revision, with cheap materialized eligibility/readiness projections where full vectors should not be loaded. Distinguish stored, reviewed, current-space-searchable and actually selected context. Proposed tests run the same fixtures through workspace projection and runtime recall, including space changes, invalid vectors, tombstones and expiry; never claim inRecall for a deterministically ineligible row.

**Acceptance to establish:** Pass old-space, malformed-vector, expired, superseded and tombstoned memories through both workspace projection and actual recall. Never label an ineligible row in recall; distinguish stored, reviewed and searchable.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/knowledge-workspace-read.ts#L230-L249), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/knowledge-workspace-read.ts#L369-L381), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/graph-recall.ts#L129-L155)

### HM04: Processor completion has a crash gap, and the last allowed live attempt can be retired early

**Current status:** Partial; source changes and focused checks.

**Observed condition:** HM04 · P1/P2 reliability · Processor completion has a crash gap, and the last allowed live attempt can be retired early

**Required improvement:** atomically persist a deduplicated extraction outbox item with successful callback consumption; distinguish processing, processed-awaiting-extraction, extracting and terminal states. Retire only an exhausted failed or stale attempt, with generation/token compare-and-swap; successful text must never be reprocessed merely to repair queue delivery. Make identical callbacks idempotent and release claims only for the expected attempt token.

**Acceptance to establish:** crash between result and enqueue, delayed extraction, callback replay, third attempt plus a concurrent fresh sweep, and a stale launch failure releasing after a newer claim. Require one logical extraction, no invalidation of a live final attempt, and no unnecessary external rerun.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/document-processor.ts#L231-L280), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/document-processor.ts#L315-L359), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/document-processor-repository.ts#L8-L112), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/document-processor.ts#L26-L185)

### HM07: Consolidation can turn dated historical facts into current timeless facts

**Current status:** Partial; source changes and focused checks.

**Observed condition:** two live, unexpired memory rows about a former job carry ended validity in columns. Merge combines their prose, discards the time boundary, and replaces both. The new fact is now eligible as current employment; source-created timestamp also becomes “now.”

**Required improvement:** temporal scopes and explicit uncertainty must be merge invariants; refuse incompatible spans; carry a supported common span and per-claim provenance or retain separate claims. Never widen temporal truth silently. Include temporal metadata in review input and validate model proposals before writing.

**Acceptance to establish:** merge past, future-starting, partially overlapping, and unknown-span facts; current-state recall/card must not widen their truth interval. Test both adapters and graph re-extraction after merge.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/consolidation.ts#L352-L357), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/consolidation.ts#L433-L452), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/consolidation.ts#L538-L555), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-consolidation.ts#L317-L343), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-consolidation.ts#L402-L423), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/consolidation.ts#L125-L131), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/consolidation.ts#L207-L220), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-consolidation.ts#L224-L233), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-consolidation.ts#L357-L367)

### HM08: Graph date normalization instructions conflict with literal grounding

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The graph model is required to resolve relative dates to ISO date labels (knowledge-graph.ts 421–422). graphRelationshipIsGrounded 218–243 requires both endpoint labels occur literally (normalized) within the quoted source. buildProjection 486–492 runs that guard BEFORE date canonicalization. For source “The trip starts tomorrow,” a correctly resolved date object 2026-10-07 fails the guard because the source says “tomorrow.” The source can still be marked processed after replacing its graph with zero accepted relations (912–922), so there is no missing-date retry signal.

**Required improvement:** separate quoted endpoint surface spans from canonical values; validate the literal span against the source first, then deterministically resolve the date using the source event timestamp/timezone. Keep rejection counts/reasons, distinguishing legitimate no-relations from rejected outputs.

**Acceptance to establish:** relative tomorrow/Friday/next month, spelled-out absolute dates and already-ISO text; require accepted grounded date relations with stable canonical IDs. Model outputs must follow the actual prompt, not a fake returning raw relative labels contrary to instructions.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L218-L243), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L421-L422), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L486-L492), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L912-L922)

### HM09: Predicate canonicalization erases past tense and grounding does not establish direction or negation

**Current status:** Partial; source changes and focused checks.

**Observed condition:** predicate-vocabulary.ts 247–280 strips was_ and were_, then maps employed_by to works_at (219) and married_to to spouse_of (238). Thus “was employed by” or “was married to” can become a current relation despite comments 212–215 promising tense preservation; no end qualifier is required. Separately, graph grounding checks only token membership (knowledge-graph.ts 234–242). A source “Alice is father of Bob” passes for a reversed Bob father_of Alice edge, and a quoted negated statement passes a positive predicate if all words occur.

**Required improvement:** retain tense/polarity/modality and explicit subject-object spans; distinguish lexical grounding from entailment. Never describe token presence as proof the relation is true. Conservative extraction plus an independent bounded entailment check can supplement, but must preserve original source and uncertainty.

**Acceptance to establish:** past employment/marriage, “not,” “might,” quoted hypothetical, swapped endpoints, two clauses sharing entities, and pronouns. Require preserved past/uncertain state and reject unsupported direction/polarity.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/predicate-vocabulary.ts#L212-L280), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L218-L243), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L421-L422), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L486-L492), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L912-L922)

### HM14: Portable consolidation can retire every member of a fact cycle

**Current status:** Partial; source changes and focused checks.

**Observed condition:** consolidation.ts 125–131 gives the newest member of each individual group a 0.15 bonus, so the preference is not transitive across overlapping groups. The portable path 207–220 records losers without removing retired candidates from later groups. Let A be oldest with confidence .95, B middle .85, and C newest .75, none owner-confirmed: groups [A,B], [B,C], [C,A] yield A→B, B→C and C→A. Firestore memory-consolidation.ts 224–233 rejects unknown/self edges but not cycles; 357–367 accepts all three and expires every fact. SQL instead removes a retired member from byId during its sequential application, so parity tests must cover this divergence.

**Required improvement:** validate the entire proposed replacement graph, collapse overlapping duplicate components under a global total ordering, forbid cycles and pointers to retired/non-live winners, and keep contradictions separate from equivalence groups. Persist an audit record that links the accepted decision to source members. Do not allow model-provided grouping topology to determine destructive semantics unchecked.

**Acceptance to establish:** the three-node case above; reversed group order; contradictory overlapping groups; a winner later merged; owner-confirmed/pinned members; assert at least one valid survivor per duplicate component and an acyclic replacement graph in both adapters.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/consolidation.ts#L125-L131), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/consolidation.ts#L207-L220), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-consolidation.ts#L224-L233), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-consolidation.ts#L357-L367), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/consolidation.ts#L538-L555), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-consolidation.ts#L402-L423), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/consolidation.ts#L352-L357), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/consolidation.ts#L433-L452), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-consolidation.ts#L317-L343)

### HM15: Voice archive ingestion can attribute third-party writing to the owner

**Current status:** Partial; source changes and focused checks.

**Observed condition:** HM15 · P1 authority · Voice archive ingestion can attribute third-party writing to the owner

**Required improvement:** parse RFC mailbox identities and MIME structure before normalization, distinguish authenticated author from display name, and retain quotation/forward boundaries through every stage. A raw text corpus explicitly supplied as the owner's writing may remain a separate confirmed mode. Uncertain attribution should be excluded or reviewed, not silently accepted. Share this provenance contract with live email ingress; its downstream taint enforcement is owned by the runtime/channel reviewers.

**Acceptance to establish:** same display name with another mailbox, owner email embedded in display name, HTML blockquote, localized reply separators, nested forwards, and genuine owner-only multipart messages. Verify only supported owner-authored spans enter writing samples, on both storage backends.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/voice-ingest.ts#L101-L149), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/import-parsers.ts#L62-L82), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/email-provenance.ts#L15-L49), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/import-parsers.ts#L90-L154), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/import-parsers.ts#L218-L228)

### HM16: Archive parsing silently loses content and substitutes a window's median date for individual evidence

**Current status:** Partial; source changes and focused checks.

**Observed condition:** windowUnits 218–228 retains a median date for a group but omits each message's date from the text sent for extraction. The SQL and portable import writers default validFrom to that median (import.ts 623,851), and age-scaled confidence uses it too. Two neighboring export records from different years can therefore give an undated statement the other message's year; an archive's upload order is not a temporal fact.

**Required improvement:** a real MIME parser with CRLF support; chunk long units without loss; structured parse diagnostics and per-unit source offsets/date/author; never substitute a group median as a claim's start date. Record exact supported input formats, accepted/rejected unit counts, and partial completion. Separate observation date from validity start.

**Acceptance to establish:** LF/CRLF equivalents, base64 and quoted-printable text, long message with decisive final sentence, malformed/empty JSON, and out-of-order messages from widely separated years. Require preserved content and dates or an explicit actionable unsupported/partial outcome.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/import-parsers.ts#L90-L154), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/import-parsers.ts#L218-L228), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/import.ts#L603-L625), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/import.ts#L838-L852), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/import.ts#L128-L160), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/import.ts#L1029-L1110), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/import.ts#L639-L660), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/import-parsers.ts#L62-L82)

### HM17: Segment watermarks skip unresolved messages and can hide more relevant raw evidence

**Current status:** Partial; source changes and focused checks.

**Observed condition:** HM17 · P2 · Segment watermarks skip unresolved messages and can hide more relevant raw evidence

**Required improvement:** explicit per-message coverage/repair state and stable (timestamp,id) cursors, no watermark leap over unresolved gaps, singleton handling, bounded summaries covering all committed spans, and blended/reranked segment plus raw retrieval. Preserve fallback quality and source range so later repair is possible.

**Acceptance to establish:** singleton then multi-turn topic, delayed embedding recovery, timestamp ties across page limits, decisive last turn beyond 6,000 characters, failed summarizer later recovering, and a raw correction more relevant than a segment. Require every source turn to remain eligible and retrievable.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/segmentation.ts#L145-L171), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/segmentation.ts#L239-L327), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/conversation-segmentation.ts#L70-L105), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/recall.ts#L149-L159)

### HM18: SQL skill reflection can overwrite an owner edit made during model/embedding work

**Current status:** Partial; source changes and focused checks.

**Observed condition:** HM18 · P1/P2 authority · SQL skill reflection can overwrite an owner edit made during model/embedding work

**Required improvement:** atomic conditional update or versioned compare-and-swap protecting live ownerAuthored state, transactionally checked at write time; separate immutable revision authorship and task checkpoint from the skill's original provenance. Human revisions must survive stale automated drafts. Address ID-only edit/delete authorization separately with the application/security finding.

**Acceptance to establish:** pause after pre-read, perform owner edit/create, resume reflection and assert no overwrite or downgrade; repeat a task that revised an existing skill and require a stable processed checkpoint. Include concurrent manual rename and deprecation.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/skills.ts#L54-L116), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/skill-reflect.ts#L167-L184), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/skill-reflect.ts#L216-L252)

### HM20: All-day event display shifts dates in UTC+12 and later zones

**Current status:** Partial; source changes and focused checks.

**Observed condition:** ownerEventWhen says it renders a bare date without timezone shifting (owner-text.ts 123–128), but 135–138 converts it to noon UTC and passes it through ownerDate in the owner's timezone. In Pacific/Auckland during UTC+12/+13 or Pacific/Kiritimati UTC+14, noon UTC is the following local calendar day. An all-day event dated October 6 is therefore labeled October 7. Tests cover a western timezone but do not establish the advertised worldwide date-only invariant.

**Required improvement:** represent all-day dates as civil calendar dates, compare their date keys with the owner's local today/tomorrow, and format without instant conversion. Timezone belongs to timed instants, not date-only values.

**Acceptance to establish:** all-day date in UTC−12, UTC, UTC+12, UTC+13 and UTC+14, with DST transitions and date-boundary now values; the provider's date must remain unchanged.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/owner-text.ts#L123-L138)

### HM22: Large documents can be marked fully ready after indexing only a prefix

**Current status:** Partial; source changes and focused checks.

**Observed condition:** documents.ts 89–117 stops chunking at MAX_CHUNKS (4,000) and returns only the chunks, with no truncation indicator or continuation offset. Finalization 481–510 marks the document ready, stores the original full charCount and reports “extracted … (full charCount chars).” Text beyond the covered prefix is absent from semantic search while the readiness/result contract suggests complete processing. Long processed PDF/OCR output can reach the cap even if compressed upload bytes are bounded.

**Required improvement:** explicit indexed character ranges and completion state, chunk continuation or an honest partial/unsupported status, and UI/search disclosure of unindexed regions. The normal model router validates embedding cardinality, so the optional null embedding fallback is defense-in-depth, not a demonstrated normal-path missing-vector failure.

**Acceptance to establish:** document exceeding the cap with a unique final-page fact; ensure either all content is indexed through resumable pagination or completion is explicitly partial and searches cannot imply whole-document coverage. Include processor expansion from small compressed input.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/documents.ts#L89-L117), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/documents.ts#L481-L510)

### MC-11: Forwarded ingestion loses the pipeline after a message-only crash checkpoint

**Current status:** Partial; source changes and focused checks.

**Observed condition:** crash or ingest-record write failure after message commit but before recordIngest commit, before a triage task exists.

**Required improvement:** one durable staged ingest state machine keyed by owner/mailbox/message, atomically record source+scoring work state, and resume each uncompleted stage without rerunning already paid inference. A duplicate source is a resume signal, not automatic completion.

**Acceptance to establish:** fault after each message/ingest/task/triaged checkpoint; replay and restart on both adapters; assert one source row, one scoring charge when prepared result exists, one task and complete ingest metadata. Also preserve below-threshold cardCandidate decisions across replay, currently absent from ingestRecord response.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L629-L693), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/message-repository.ts#L9-L29), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/email-sync-repository.ts#L138-L172), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L1058-L1128), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L927-L1031), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L515-L557)

### ME-01: One oversized contact poisons the whole job after paid work

**Current status:** Partial; source changes and focused checks.

**Observed condition:** 1. Output schema accepts at most 25 facts and 10 occasions: extraction.ts:37–80 2. Portable extraction calls the model, embeds all facts, then calls applyMemories: extraction.ts:435–482 3. Storage caps existing occasions at 100: memory-extraction.ts:43–48 4. After contact resolution, each distinct existing contact is queried by agentId and contactId with limit(101); there is no filter for kind/date, source, or quarantine. At 101 rows it throws: memory-extraction.ts:274–293 5. No per-conversation catch surrounds applyMemories; its exception exits the loop. extractCommitments runs only after runMemoryExtraction returns successfully: extraction.ts:426–492, jobs.ts:381–398

**Required improvement:** Use bounded identity-specific reads for the proposed occasion keys, rather than scanning every occasion for a person. Preserve legacy random-ID rows and detect ambiguous duplicates explicitly; blindly reading only the deterministic ID can create a duplicate beside a legacy row. The existing canonical identity is owner/person/kind/month/day: occasionDocumentId:87–102.

**Acceptance to establish:** At and beyond the per-person occasion bound, validate before paid work and isolate the overflowing item. Existing unaffected people/facts still process; no whole batch is lost or regenerated repeatedly.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L37-L80), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L435-L482), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L43-L48), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L274-L293), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L426-L492), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/jobs.ts#L381-L398), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L371-L453), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/profile-occasion-command.ts#L105-L200), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-consolidation.ts#L87-L102), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L150-L183), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L46-L74), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L80-L204), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L107-L125), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L252-L332), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L472-L482), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L302-L314), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L100-L200), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L116-L197), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L233-L465), [reference 20](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L89-L97), [reference 21](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L423-L429), [reference 22](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L368-L453), [reference 23](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L25-L33)

### ME-02: Deterministic persistence errors regenerate and re-embed up to eight times

**Current status:** Partial; source changes and focused checks.

**Observed condition:** extractConversation specially handles unparseable model output, but persistence bounds are plain errors and propagate: extraction.ts:150–183.

**Required improvement:** Classify bound/invalid-data/ambiguous-identity errors separately from transient provider/storage failures Record the blocked contact or batch using safe identifiers and counts; isolate that failure so unrelated conversations and commitment extraction can progress If prepared outputs are retained for retry, key them to a stable source snapshot/hash and extraction version, apply privacy-erasure rules, and never treat an unapplied batch as successfully extracted Keep terminal reporting honest about partial progress; a skipped poisoned batch must remain visible and recoverable Avoid directing the owner to retry an unchanged deterministic error without a repair action

**Acceptance to establish:** Inject deterministic persistence rejection after generation/embedding, then retry and restart. Prepared paid output is retained; no repeated inference until the underlying validation/state issue changes.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L150-L183), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor.ts#L125-L185), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/task-lifecycle.ts#L288-L312), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L37-L80), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L435-L482), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L426-L492), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L46-L74), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L107-L125), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L472-L482), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L302-L314), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L100-L200), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L423-L429), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L25-L33), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L395-L482)

### ME-03: Unvalidated person creation feeds a polluted authoritative-looking catalog

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Quarantining extracted memories does not quarantine the new contact itself. The next job reads all contact names, including unknown-trust auto-created names: memory-extraction.ts:80–86,202–204. Those names are concatenated directly into the system prompt after “Known people (use these exact names…)”: extraction.ts:107–125. There is no data delimiter, semantic/type filter, individual provenance selection, or total prompt-character budget for the catalog.

**Required improvement:** use typed subjects (owner, verified contact ID, explicit new-person candidate, none), validate new-person candidates against source evidence, and keep uncertain/non-person entities out of the person catalog. Render catalog entries as bounded untrusted data rather than imperative system text. Preserve legitimate short, multilingual, mononymous and punctuation-bearing names; do not replace the defect with an ASCII-only “real name” heuristic. Existing polluted records require a reviewed cleanup proposal, not automatic deletion.

**Acceptance to establish:** Use generic nouns, pronouns, formatting noise, ambiguous names and valid explicit people as subjects. Only supported identities are created, with provenance, uncertainty and no invented authoritative contact.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L46-L74), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/contact-lookup.ts#L43-L99), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L80-L204), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L107-L125), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L37-L80), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L435-L482), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L43-L48), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L274-L293), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L426-L492), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L371-L453), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L150-L183), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/contact-lookup.ts#L10-L64), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/contact-lookup.ts#L67-L72), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L252-L332), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L472-L482), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L302-L314), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L100-L200), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L116-L197), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L233-L465), [reference 20](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L89-L97), [reference 21](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L423-L429), [reference 22](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L368-L453), [reference 23](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L25-L33)

### ME-04: Prefix matching can steal an exact identity or collapse distinct people

**Current status:** Partial; source changes and focused checks.

**Observed condition:** resolveSubjectContact resolves owner prefix first, then the first nonowner name/alias prefix from an unordered table scan. With Anna Smith and Anna Jones, extracted subject Anna is silently assigned to one; if owner is Anna Smith, owner wins without assessing ambiguity. New facts and graph identity can be attached to the wrong person even in the supported single-owner deployment. It may also automatically rename the selected person to a longer matching string. Fix: collect all candidates, prefer only unique exact verified identity, preserve unresolved subject provenance when ambiguous, ask once only when identity materially matters, and link future facts after resolution. Proposed test: two same-first-name contacts plus owner/name collision; no arbitrary attribution/rename, stable explicit disambiguation.

**Required improvement:** collect all candidates, prefer only unique exact verified identity, preserve unresolved subject provenance when ambiguous, ask once only when identity materially matters, and link future facts after resolution. Proposed test: two same-first-name contacts plus owner/name collision; no arbitrary attribution/rename, stable explicit disambiguation.

**Acceptance to establish:** two same-first-name contacts plus owner/name collision; no arbitrary attribution/rename, stable explicit disambiguation.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/entities.ts#L175-L227), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/memory-tool-repository.ts#L56-L61), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/memory-tool-repository.ts#L51-L102), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/memory-tool-repository.ts#L154-L162), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/contact-lookup.ts#L10-L64), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/contact-lookup.ts#L67-L72), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/contact-lookup.ts#L43-L99)

### ME-05: A discarded duplicate fact can still create a contact

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The transaction collects new subject names for every non-tombstoned fact, even those whose content hash already exists. In the write loop it calls contactIdFor before checking existingHash or the within-batch written set: memory-extraction.ts:252–271,322–332.

**Required improvement:** Resolve and validate candidate subject identity before creating a contact; only publish a contact together with accepted evidence or a separately authorized identity operation.

**Acceptance to establish:** Supply a duplicate/rejected fact with a previously unseen candidate subject. No orphan contact is created; a genuinely accepted fact atomically retains its valid subject link.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L252-L332), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L43-L48), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L274-L293), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L371-L453), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L80-L204), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L116-L197), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L233-L465), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L89-L97), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L368-L453)

### ME-06: Occasion-only output is silently discarded and checkpointed

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The structured schema permits zero facts and nonempty occasions, and the prompt asks for a separate occasions array. Both SQL and portable paths require at least one fact before saving occasions. Portable extraction explicitly replaces occasions with [] when output.facts.length === 0 and still commits the conversation checkpoint: extraction.ts:472–482. SQL exits before its occasion loop: extraction.ts:302–314.

**Required improvement:** Treat occasion-only extraction as a valid output and persist it before advancing the source checkpoint. Distinguish empty output from filtered, rejected and partially committed results.

**Acceptance to establish:** Produce zero memories and one valid occasion, mixed valid/rejected occasions, and a write failure. Save valid occasion-only work before checkpointing and retry only uncommitted stages.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L472-L482), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L302-L314), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L37-L80), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L435-L482), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L426-L492), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L150-L183), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L46-L74), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L107-L125), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L100-L200), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L423-L429), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L25-L33)

### DESIGN-KNOWLEDGE: Canonical assertions, inverse presentation, grouped curation and explained derivations

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Graph topology already supports two-way navigation and eligible unreviewed recall; projection-row curation does not provide durable semantic assertions or coherent correction/derivation.

**Required improvement:** Introduce canonical assertions, typed inverse views, evidence groups, conservative identity/temporal semantics and retractable derivations; keep current databases initially.

**Acceptance to establish:** Review meaning once, preserve owner rejection/edit across merge and re-extraction, answer exact relationship queries in both directions, explain derivations and retract descendants after correction/forgetting.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Models/RelationshipGraph.swift#L152-L172), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/graph-recall-repository.ts#L69-L113), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/graph-recall-repository.ts#L14-L29), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/graph-recall.ts#L64-L76), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/graph-recall.ts#L119-L185), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/schema.ts#L1096-L1155), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L53-L78), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L409-L425), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/KnowledgeView.swift#L100-L124), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/RelationshipGraphScreen.swift#L885-L943), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/knowledge/relations/%5Bid%5D/route.ts#L82-L113), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Models/APIModels.swift#L1725-L1745), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/WorkspaceView.swift#L1214-L1241), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/predicate-vocabulary.ts#L27-L65), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Models/APIModels.swift#L1445-L1457), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/PeopleView.swift#L225-L297), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/RelationshipGraphCanvas.swift#L1426-L1455), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/knowledge-graph.ts#L690-L706), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/knowledge-graph.ts#L857-L993), [reference 20](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Models/RelationshipGraph.swift#L845-L941), [reference 21](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Models/RelationshipGraph.swift#L810-L841), [reference 22](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/KnowledgeView.swift#L689-L802), [reference 23](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L211-L243), [reference 24](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/predicate-vocabulary.ts#L217-L284), [reference 25](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L419-L510), [reference 26](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L912-L922), [reference 27](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L302-L308), [reference 28](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L478-L510), [reference 29](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/knowledge-graph-sync-repository.ts#L311-L379), [reference 30](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/knowledge-graph.ts#L1138-L1173), [reference 31](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/knowledge-graph-curation.ts#L62-L82), [reference 32](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L1087-L1159), [reference 33](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L569-L610), [reference 34](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/knowledge-graph-curation.ts#L281-L322), [reference 35](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/KnowledgeView.swift#L575-L603), [reference 36](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Models/RelationshipGraph.swift#L76-L105), [reference 37](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/graph-recall.ts#L57-L198), [reference 38](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/graph-recall.ts#L202-L248), [reference 39](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/builtin/index.ts#L258-L311), [reference 40](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/persistence/src/graph-recall.ts#L36-L66), [reference 41](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/graph-gaps.ts#L164-L289), [reference 42](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/curiosity.ts#L52-L78), [reference 43](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L1039-L1064), [reference 44](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L266-L284), [reference 45](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/entities.ts#L175-L227), [reference 46](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/graph-recall-repository.ts#L14-L64), [reference 47](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/AssistantTests/APIModelsTests.swift#L758-L795)

### DESIGN-CONTEXT: Decision-aware context selection and relevance before planning

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Current-turn wording and similarity alone do not encode the actual decision, prior reasons, current constraints, freshness or source coverage.

**Required improvement:** Build a bounded discussion frame and context bundle before planning; blend/rerank raw messages, summaries, decisions, graph and commitments with provenance and abstention.

**Acceptance to establish:** Long-history, pronoun, topic change, temporary exception, old rejected option, same-name ambiguity, current-versus-historical and honest-miss cases pass without forbidden or irrelevant context.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-turn.ts#L699-L848), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/recall.ts#L78-L194), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/graph-recall.ts#L57-L198), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/graph-recall.ts#L202-L248), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L299-L437), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/schema.ts#L899-L959), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/consolidation.ts#L648-L715), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/ambient.ts#L589-L626), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/supersede.ts#L7-L35), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/consolidation.ts#L118-L132), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.ts#L15-L97), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.ts#L400-L517), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/persistence/src/situations-schema.ts#L28-L40), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/situations.ts#L442-L481), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/chat.ts#L42-L77), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/recall-feedback.ts#L23-L82), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/profile/memory-commands.ts#L46-L101), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L65-L90), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L205-L275), [reference 20](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-turn.ts#L702-L735), [reference 21](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L335-L345), [reference 22](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/graph-recall.ts#L131-L198), [reference 23](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.ts#L347-L396), [reference 24](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-turn.ts#L306-L321), [reference 25](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/chat.ts#L242-L244), [reference 26](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-turn.ts#L775-L848), [reference 27](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L457-L468), [reference 28](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/phases.ts#L516-L545), [reference 29](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-turn.ts#L267-L296), [reference 30](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-turn.ts#L719-L735), [reference 31](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/recall.ts#L54-L75), [reference 32](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/schema.ts#L899-L939), [reference 33](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.ts#L199-L219), [reference 34](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/graph-recall-repository.ts#L14-L29), [reference 35](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/graph-recall.ts#L119-L185), [reference 36](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/graph-recall.ts#L84-L109), [reference 37](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/validity.ts#L33-L66), [reference 38](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/profile-memory-management-repository.ts#L160-L188), [reference 39](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/profile-memory-management.ts#L200-L255), [reference 40](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/history-recall-repository.ts#L18-L101), [reference 41](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L100-L132), [reference 42](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/extraction.ts#L415-L444), [reference 43](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/segmentation.ts#L10-L62), [reference 44](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/segmentation.ts#L267-L306), [reference 45](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L131-L170), [reference 46](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/suggestions.ts#L83-L113), [reference 47](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/suggestions.ts#L123-L159), [reference 48](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/suggestions.ts#L218-L234), [reference 49](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/persistence/src/recall-metrics.ts#L1-L21), [reference 50](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/recall-feedback.ts#L23-L35)

### DESIGN-CONTEXT-UX: Selective use, conflict handling and useful contextual initiative

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Correct memories can still be intrusive or irrelevant, and a one-off choice can be incorrectly generalized.

**Required improvement:** Choose among quiet use, brief source-backed connection, conflict question, bounded next step and omission based on concrete decision impact and current permissions.

**Acceptance to establish:** Fifteen synthetic multi-turn scenarios show helpful continuity, no repetitive questions, no sensitive over-recall, durable correction/forgetting and no inferred new action authority.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/read-intent.ts#L103-L153), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-triage.ts#L110-L155), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-turn.ts#L267-L296), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-turn.ts#L719-L735), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/schedules.ts#L479-L510), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/question-regression/harness.ts#L736-L774), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/generative-card.ts#L7-L189), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/generative-card.ts#L942-L1027)

### FS-12: Every new Firestore watch suggestion has an ID the native decision route rejects

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Trace: watches.ts9–12 derives watch-suggestion:<sha256> and429–447 writes that value as the suggestion ID. The authenticated native POST route checks its UUID regex before choosing the persistence driver (apps/web/app/api/mobile/v1/suggestions/[id]/route.ts9,23–25). Thus a new Firestore watch suggestion can appear, but native Accept, Dismiss and Later all receive HTTP400. This does not require malformed input or concurrency. Generic Firestore suggestions.ts16–25 already uses a UUID-shaped deterministic hash specifically for this route requirement. Legacy imported UUID suggestions are unaffected; web server actions need not share the native validation.

**Required improvement:** one canonical deterministic suggestion ID generator shared by watch and other producers, plus a compatibility path/migration for existing watch IDs that preserves sourceRef deduplication. Proposed test: produce an actual watch fire and commitSuggestion, pass its returned ID to the authenticated native route for all three decisions, and verify exactly one task/outbox item on repeated acceptance. Current watch tests only call repositories; route tests use UUID fixtures.

**Acceptance to establish:** produce an actual watch fire and commitSuggestion, pass its returned ID to the authenticated native route for all three decisions, and verify exactly one task/outbox item on repeated acceptance. Current watch tests only call repositories; route tests use UUID fixtures.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/watches.ts#L9-L12), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/watches.ts#L429-L447), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/suggestions/%5Bid%5D/route.ts#L9-L46), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/suggestions.ts#L16-L25)

### HC-09: Proactive “Still open” is not proof the owner still owes an action

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The pinned pulse implementation creates the “Still open” label directly from subject/sender: pulse.ts:454–502. Its PostgreSQL candidate query requires stored actionable=true and importance threshold, a recent ingest-created timestamp, and no associated triage task marked done: pulse.ts:655–682.

**Required improvement:** Track source-backed real-world obligation state independently of triage task completion. Recheck resolution, current source lifecycle and prior owner decisions before saying still open.

**Acceptance to establish:** Mark triage done while a real obligation remains; resolve the real obligation while an old task remains. Notices follow source-backed obligation state and do not infer either conclusion from task status alone.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L454-L502), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L655-L682), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-importance.ts#L104-L114)

### HM01: Closing a commitment does not fence replay of the same source occurrence

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Firestore confirms the same behavior: packages/firestore/src/memory-extraction.ts 517–530 only keeps active twins, and 558–595 creates a fresh row if none remain. Its bound is worse than its comment: it queries and counts all historical rows before filtering active. Once the same hash has more than ten historical occurrences, the entire batch throws; resolved rows alone can exhaust this lifetime ceiling. Same-job checkpoints prevent one exact job retry, but a later extraction job over the unchanged rolling window still reopens the occurrence.

**Required improvement:** model commitment occurrences with stable source IDs/ranges and resolution/dismissal watermarks. A genuinely new occurrence after closure may create a new record, but the same or older evidence must not. Preserve semantic identity separately from editable title/details; require new evidence for recurrence and maintain explicit reopening semantics.

**Acceptance to establish:** extract transcript S, dismiss/correct/resolve it, rerun the same source through both adapters, and assert no resurrected old occurrence. Add a genuinely later owner statement and assert a deliberate new occurrence is permitted. Include paraphrased model outputs and concurrent closure during extraction.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.ts#L107-L223), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.test.ts#L181-L210), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.ts#L400-L503), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L517-L595), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.ts#L532-L548), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.test.ts#L342-L400), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/memory-extraction.ts#L434-L452), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.ts#L426-L448)

### HM02: Time-based cleanup can discard future promises and the reminder just snoozed

**Current status:** Partial; source changes and focused checks.

**Observed condition:** commitments.ts 532–548 retires an eligible open/expired-snooze row when either its kind-specific idle period elapsed OR its due date is old. There is no exemption for a due date in the future. An explicit promise due in six months is removed from live recall after 45 idle days (commitments.test.ts 342–363 confirms the window). A question snoozed for 60 days is protected only until the snooze expires, then immediately stale because the idle clock started when it was snoozed; test 377–400 codifies that behavior. listOpenCommitments 347–384 excludes stale rows.

**Required improvement:** distinguish unconfirmed stale suggestions from explicit accepted promises; protect future due dates and use a snooze wake state/review window measured from wake time. Do not infer completion/cancellation from age. If retirement is desired, retain an actionable review state and surface missed-deadline handling rather than quietly removing obligations.

**Acceptance to establish:** future due date beyond each idle threshold; long snooze spanning threshold; overdue but recently re-confirmed promise; wake and cleanup in either order. Require an open obligation to survive until resolved or consciously archived.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.ts#L532-L548), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.test.ts#L342-L400), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.ts#L107-L223), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.test.ts#L181-L210), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.ts#L400-L503), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.ts#L426-L448)

### HM10: Calendar window disappearance is asserted as cancellation

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Pulse reads only [now, now+6h] (pulse.ts 775–780). diffCalendarEvents 195–212 treats any previously upcoming event absent from a complete result as cancelled. Moving today's meeting to tomorrow produces a perfectly complete six-hour result without that event. The notice says it “has been cancelled” (pulse.ts 379–383), despite it still existing and being rescheduled. Complete query results establish membership in that query window, not deletion of every previously seen object.

**Required improvement:** verify missing stable IDs with an authoritative event lookup/tombstone or maintain provider sync tokens and explicit deletion state. Until verified, label “no longer in this window; checking change” and avoid consequential dependent actions. Track moves outside the query interval and changed calendar selection separately.

**Acceptance to establish:** event moved beyond horizon, moved earlier than now, removed calendar access, deselected calendar, explicit cancellation, pagination truncation. Only verified cancellation may produce the cancellation claim.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L775-L780), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/calendar-diff.ts#L195-L212), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L379-L383), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L655-L703), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L829-L874)

### HM11: Candidate limits and snooze state can suppress valid due reminders

**Current status:** Partial; source changes and focused checks.

**Observed condition:** pulse.ts actionableMail limits to five before checking already-said keys (655–682,829–835,864–874). Five previously notified high-importance rows can keep a sixth unsaid row out of every candidate set until the first five age out. Due commitments similarly limit an unordered set to five (683–703). More directly, due selection requires status='open' (695), although snoozeCommitment leaves status='snoozed' and listOpenCommitments deliberately admits expired snoozes. No transition back to open exists in this reviewed module; expired snoozes can therefore be visible in recall yet excluded from due notifications.

**Required improvement:** exclude already-admitted occurrences in storage selection, deterministically order by deadline/value, page until enough unsaid candidates, and define an explicit snooze wake transition or consistent active predicate across every consumer. A changed due date should use a changed occurrence identity rather than permanent commitment-due:<id> suppression.

**Acceptance to establish:** six messages/commitments with first five already said; tie ordering; expired snooze before due; rescheduled commitment after prior nudge; pace and cap recovery without losing urgent observations.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L655-L703), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L829-L874), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.ts#L426-L448), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.ts#L107-L223), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.ts#L400-L503), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.ts#L532-L548), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L775-L780), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L379-L383)

### HM23: Curiosity claims a question forever before durably posting it

**Current status:** Partial; source changes and focused checks.

**Observed condition:** curiosity.ts 65–72 first writes the asked-gap ledger and only then calls postOwnerNotice. Its declared behavior is never to ask a previously asked gap again (22–24). A crash or notice-write failure after the ledger claim suppresses a question the user never received. This differs from intentionally staying quiet or a phone push being held after a dashboard copy is saved.

**Required improvement:** atomic notice plus claim/outbox, or a leased pending claim that becomes asked only after durable notice persistence. Use typed outcomes for skipped, pending, posted, held and delivered. notify.ts 15–20 returns Promise<void>, and 34–35 interprets any resolution as ping success; actual quiet-hour/no-device outcomes need to be carried back from the notifier rather than flattened.

**Acceptance to establish:** crash after claim and before notice, fail notice creation, concurrent producers, and push intentionally held after notice. Require eventual single visible question, no false permanent asked state, and honest channel outcome reporting.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/curiosity.ts#L60-L78), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/notify.ts#L15-L39)

### MC-13: Watch dedupe commits before notifications/suggestion enqueue

**Current status:** Partial; source changes and focused checks.

**Observed condition:** process crash/DB/transient notifier/queue failure between durable watch firing and its downstream delivery or suggest task.

**Required improvement:** atomically write independently replayable notice/suggestion outbox entries with each fire; preserve once-only event admission while allowing retry of undelivered work. Return leg status rather than blanket success.

**Acceptance to establish:** failure/restart at every boundary, bounded maxFires=1, repeated source message, one notifier leg down, and suggestion enqueue outage. Assert eventual visible notice/proposal without duplicate external sends.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/watches/fire.ts#L22-L53), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/watches/email-watches.ts#L61-L94), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/watches/web-watches.ts#L124-L153), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/watches/web-watches.ts#L111-L137)

### MC-14: Web watch dedupe suppresses a genuine later repeated transition

**Current status:** Partial; source changes and focused checks.

**Observed condition:** unlimited/bounded>1 contains watch sees Sold out→In stock→Sold out→the identical In stock page; or change watch A→B→A→B.

**Required improvement:** identify an admitted transition by prior-state/version plus current-state and claim generation; use source fingerprint for state comparison, not lifetime event identity.

**Acceptance to establish:** repeated cycles, concurrent/duplicate same-generation polls, restart during transition, and maxFires counter consistency. Confirm equivalent behavior in Firestore before closing the cross-adapter review.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/watches/web-watches.ts#L111-L137), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/watch-repository.ts#L144-L193), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/watches/web-watches.ts#L124-L153)

### PS-01: Calendar conflict evidence and identity

**Current status:** Partial; source changes and focused checks.

**Observed condition:** For the supplied textual structure, the useful family tokens are united, albion; the import shares only albion. The different full address strings do not contain each other. The 45-minute start difference and shared finish pass the temporal check, but the title/location gate fails. Absent matching provider identity, current code deterministically preserves these as two conflicting groups. This matches the screenshot’s failure condition; it does not establish which production revision generated the screenshot.

**Required improvement:** Preserve event identity at occurrence granularity: provider/calendar/event IDs, series UID, original occurrence start, and source calendar; do not equate series membership with occurrence identity Distinguish exact duplicate, probable duplicate, genuine overlapping obligations, and unresolved identity; only high-confidence identity collapses rows Represent arrival/warm-up and kickoff as compatible time roles when supported by source text; do not erase the earlier arrival requirement Use source-backed venue aliases or normalized venue identity alongside participant/opponent evidence; different street entrances should be compatible evidence, not an unconditional merge Keep coverage completeness separate from identity/attendance confidence in both native and web presentation Exclude explicitly cancelled/non-blocking/owner-declined events from hard conflicts according to an explicit product policy; retain relevant shared-family obligations without assuming every shared-calendar row is personally attended

**Acceptance to establish:** These are proposed fixtures, not executed results

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L315-L393), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.test.ts#L430-L453), [reference 3](https://developers.google.com/workspace/calendar/api/v3/reference/events), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.test.ts#L456-L483), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/calendar.ts#L31-L47), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/calendar.ts#L144-L168), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L414-L444), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L404-L413), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L975-L999), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3115-L3125), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L482-L529), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L212-L239), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/calendar.ts#L570-L591), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L692-L704), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L970-L1025), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L4394-L4409), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/calendar.ts#L144-L166), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.test.ts)

### PS-02: Cancellation, supersession, and stale suggestions

**Current status:** Partial; source changes and focused checks.

**Observed condition:** EmailImportanceSchema.dates contains only iso and what. There is no date role, cancellation/reschedule state, booking identity, source timezone, or explicit evidence span. The extraction prompt asks for dates in commitments, while changed/cancelled bookings are high-importance categories. The mail ingestion path stores the extracted dates unchanged.

**Required improvement:** Model each source observation as evidence about a specific commitment/booking occurrence. Track lifecycle and supersession independently from whether a message was ingested or a task ran. At minimum distinguish active/confirmed, cancelled, rescheduled, tentative, and unknown, plus date roles such as event start, previous start, payment deadline, cancellation deadline, and refund expectation.

**Acceptance to establish:** Confirmation at T1 → cancellation at T2 for booking R-314: no new create proposal; old pending/snoozed create proposal becomes superseded Same scenario with an exact existing calendar event: offer one bounded reconciliation action; preserve unrelated appointments Cancellation with no calendar match and no remaining obligation: no busywork “add to calendar” or “check what this needs” suggestion Cancellation then reinstatement: latest authoritative lifecycle wins; original historical receipt remains readable Reschedule with old and new timestamps in one message: one current event/update proposal, never two independent create proposals “Free cancellation until” or conditional cancellation text: retain correct date role, do not mark booking cancelled Two bookings with same sender/title/date but different booking IDs: do not cross-cancel Accept-versus-cancel race on both persistence backends: stale task must not create the cancelled booking Date-array order changes: identity should not depend on array index

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-importance.ts#L74-L82), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-importance.ts#L103-L114), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L679-L693), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L482-L529), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L212-L239), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/suggestions.ts#L130-L198), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/suggestion-decisions.ts#L174-L224), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/calendar.ts#L570-L591), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/dispatcher.ts#L652-L665), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/calendar-diff.ts#L175-L227), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L315-L393), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/calendar.ts#L31-L47), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/calendar.ts#L144-L168), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L414-L444), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L404-L413), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L975-L999), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L629-L677), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-importance.ts#L158-L185), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L692-L704), [reference 20](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-importance.ts#L217-L255), [reference 21](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L472-L495), [reference 22](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L970-L1025), [reference 23](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/suggestions.ts#L85-L113), [reference 24](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/suggestions.ts#L218-L234), [reference 25](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/calendar.ts#L144-L166)

### PS-03: Duplicate security alerts and cross-surface repetition

**Current status:** Partial; source changes and focused checks.

**Observed condition:** An original and recovery-account copy are distinct messages. Ingestion identity alone does not cluster them. Briefing identity is display text, not an incident identifier: different display names/subject variants survive; conversely, separate sign-ins with the same sender/subject can be collapsed. The classifier input and prompt is one mail plus sender trust, not previous incident decisions, account activity, or a known recovery-copy relationship.

**Required improvement:** eligible for reassessment with an explicit reason it is new Process restart/concurrent workers: durable incident identity, no duplicate admission No confident match: preserve separate source evidence and avoid stating an inflated incident count as fact

**Acceptance to establish:** Replay original/recovery copies and concurrent producers for one security issue, then introduce a distinct new incident from the same sender. Suppress unchanged copies, retain material new events and verify actual live symptom attribution separately.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L629-L677), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-importance.ts#L103-L114), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-importance.ts#L158-L185), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L692-L704), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-importance.ts#L217-L255), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L472-L495), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L454-L500), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L315-L393), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L414-L444), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L404-L413), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L975-L999), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-importance.ts#L74-L82), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L679-L693), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L482-L529), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L212-L239), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L205-L275), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L655-L682), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L970-L1025)

### PS-04: Ranking, context, and dismissed-card accumulation

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The daily briefing treats importance ≥3, extracted upcoming dates, or salient calendar events as news. Importance 3 explicitly includes confirmations and receipts. It can create a proposal for each of up to eight upcoming dates; creation is not gated by whether the calendar already contains the event. Proposal loop.

**Required improvement:** Prioritize an evidence/attention boundary over more prompt prose or generic keyword filters

**Acceptance to establish:** One realistic synthetic day should exercise arrival, briefing, pulse, task completion, dismissal, and refresh together: an original/recovery security pair, a routine receipt, a confirmed appointment already on calendar, a later cancellation of a different appointment, a genuinely unanswered deadline email, and a routine evening practice. Expect only the materially useful decisions, correct current lifecycle, and no reappearance merely because another producer runs.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L205-L275), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse-selection.test.ts#L32-L109), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L655-L682), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/pulse.ts#L218-L260), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L970-L1025), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/calendar-salience.ts#L26-L51), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/calendar-salience.ts#L164-L180), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/nudge-policy.ts#L8-L27), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/suggestions.ts#L85-L113), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/suggestions.ts#L218-L234), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/firestore-briefing.test.ts#L299-L328), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/inline-suggestion.tsx#L130-L202), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L4394-L4409), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L315-L393), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L414-L444), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L404-L413), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L975-L999), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3115-L3125), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L482-L529), [reference 20](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L212-L239), [reference 21](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/suggestions.ts#L130-L198), [reference 22](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L692-L704), [reference 23](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L454-L500), [reference 24](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse-selection.test.ts), [reference 25](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/firestore-briefing.test.ts)

### PS-05: Berlin spa timezone

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The screenshot reportedly shows 09:40 AM while the booking confirmation says 16:40 CEST. The actual event date, agent timezone, phone timezone, stored extracted ISO string, and producing surface are not established here. Those are necessary to determine whether the instant is wrong, the timezone presentation is misleading, or both.

**Required improvement:** Carry source/venue timezone, civil date precision and originating reference time explicitly through extraction, storage and display; investigate the screenshot against exact source evidence before assigning a root cause.

**Acceptance to establish:** Use source-local spa/booking times, travel zones, DST and ambiguous timezone evidence. Preserve the actual event instant/civil date or ask clearly; do not claim the historic screenshot fixed without its exact record.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-importance.ts#L217-L255), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L482-L529), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/owner-text.ts#L83-L121), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/calendar.ts#L144-L166), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/owner-text.test.ts#L84-L168), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L315-L393), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/calendar.ts#L31-L47), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/calendar.ts#L144-L168), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L414-L444), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L404-L413), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L975-L999), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-importance.ts#L74-L82), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-importance.ts#L103-L114), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L212-L239), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/calendar.ts#L570-L591), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-importance.ts#L158-L185), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L692-L704), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing.ts#L970-L1025)

### MC-06: Embedding calls ignore disabled model rows

**Current status:** Partial; source changes and focused checks.

**Observed condition:** owner disables embedding model while embed role remains pointed at it and connection stays on.

**Required improvement:** shared enabled/modality/space validation before reservation/provider construction; do not silently change embedding space to fallback. Test disabled catalog model => no reserve/provider call; enabled wrong modality => explicit refusal; role change with expectedModelId remains refused.

**Acceptance to establish:** Disable the embedding catalog row while its role and connection remain configured. No reserve/provider call occurs; wrong modality and model-space revision are rejected before paid work.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1634-L1679), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L711-L735), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1701-L1724)

### MC-07: Connection revocation has stale/fail-open windows

**Current status:** Partial; source changes and focused checks.

**Observed condition:** disable/revoke connection in another process; calls continue within TTL and indefinitely through repeated refresh failures. On first-load failure an env credential can be used even if durable connection is disabled.

**Required improvement:** fail closed on uninitialized policy lookup, use monotonic connection policy epoch/revocation read or bounded safe stale policy, distinguish metadata/credential refresh availability from deny/revoke decisions. Tests: cold-load failure with disabled stored connection, warm disable across processes, persistent DB failure, and restored refresh. No recommendation to route around disabled credentials.

**Acceptance to establish:** cold-load failure with disabled stored connection, warm disable across processes, persistent DB failure, and restored refresh. No recommendation to route around disabled credentials.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/connections.ts#L165-L228), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/connections.test.ts#L180-L214)

### API-04: Card-image response cap is enforced after allocation

**Current status:** Partial; source changes and focused checks.

**Observed condition:** An authenticated request to a remote server that declares an allowed raster MIME type and omits/understates length can consume substantially more than 5 MiB before rejection. The eight-second timeout bounds duration, not bytes or memory. Large concurrent responses can pressure or terminate the web process. Body-read errors after the fetch are also outside the fetch catch and become unstructured failures.

**Required improvement:** Read through a bounded stream, count actual decoded bytes, cancel immediately on overflow, and map fetch/body errors consistently. Apply streaming request limits to uploads and auth bodies too: runtime.ts:143–149 checks 64 KiB only after request.text(), and upload handlers parse multipart before inspecting individual file size. Cloud Run's request cap is useful but is not a portable in-process bound for local deployments or aggregate multipart fields.

**Acceptance to establish:** Chunked/no-length image exceeding the cap, declared short body, decompression expansion, slow/broken body, immediate cancellation and concurrent requests. For uploads, test total multipart bytes and extra fields, not only the selected file's size. No dedicated card-image security test exists in this partition.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/card-image/route.ts#L48-L54), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/proxy.ts#L204), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/lib/owner-auth/runtime.ts#L143-L149), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/lib/owner-auth/runtime.ts#L84-L92), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/lib/owner-auth/runtime.ts#L113-L139), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/card-image/route.ts#L8-L46), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/lib/owner-auth/runtime.ts#L14-L110)

### API-05: Card-image DNS preflight is not bound to the actual connection

**Current status:** Partial; source changes and focused checks.

**Observed condition:** An attacker-controlled hostname can change answers between validation and connection. The stated destination check therefore does not prove that the eventual socket uses an approved public address. This is not proof of metadata exfiltration: the route requires owner auth, HTTPS, no explicit port, no userinfo, redirects off and a permitted image MIME type; TLS name/certificate verification and the destination protocol remain constraints.

**Required improvement:** Reuse a central reviewed outbound transport that normalizes all address forms and pins validated DNS results through connection establishment, or use a trusted image service/allowlist. Keep redirect rejection and credential omission. Avoid writing another bespoke IP classifier.

**Acceptance to establish:** Public-preflight/private-connect rebinding using a synthetic resolver, mixed public/private answer sets, IPv4-mapped IPv6, loopback/link-local/unique-local/reserved ranges and redirects. Assert no prohibited connection is attempted, rather than merely inspecting the preflight result.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/card-image/route.ts#L8-L46), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/card-image/route.ts#L48-L54)

### API-09: One workspace section failure blocks unrelated native screens

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A malformed graph/profile record, a bounded-scan overflow, one repository outage, or one settings/readiness failure can stop the client loading unrelated costs, skills, chats or settings. The source tests intentionally fail closed on malformed private data; that defense should remain, but does not require hiding all independently valid sections. Several normal growing datasets also eventually exceed hard scan/write bounds, while routes offer no cursor/recovery path.

**Required improvement:** Split independent native destinations into bounded query endpoints, or expose typed per-section availability and version metadata. Never substitute empty successful lists for failed reads. Retain an outer owner/privacy-erasure fence where sections are composed and avoid delivering private partial data across a changed erasure generation. Add resumable pagination/batching for growth beyond current bounds.

**Acceptance to establish:** Each section failing independently, slow billing, malformed private data, active/completed erasure during composition, and documented scan overflow. Verify unrelated destinations remain usable and unavailable sections show truthful errors. Relevant current limits are asserted in documents/route.firestore.test.ts:453–523 and activity/route.test.ts:240–253.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/lib/firestore-mobile-workspace.ts#L44-L75), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/workspace/route.ts#L42-L66), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/documents/route.firestore.test.ts#L453-L523), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/activity/route.test.ts#L240-L253), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/workspace/route.ts#L33-L37)

### APP-01: Firestore composition drops configured heavy-document processor

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Firestore installation has documents module and PROCESSOR_DRIVER=cloudrun (or local queue launcher), and a PDF/office/image requires documents.process. composeFirestoreAgent installs the module but never obtains/returns its export. The task ends as done without launching, leaving pending documents unavailable to retrieval.

**Required improvement:** forward both driver-specific module exports consistently from a shared composition contract; make required configured capabilities fail readiness rather than silently no-op. Proposed regression: build actual Firestore composition with a synthetic launcher, ingest heavy-format document, enqueue through real task-runner, assert exactly one launch and final extraction. Existing firestore-document-processing.test.ts95–123 injects config directly; firestore-full-composition.test.ts168–204 only constructs/registers tools/sweeps and does not cover this chain. These tests were inspected, not executed.

**Acceptance to establish:** build actual Firestore composition with a synthetic launcher, ingest heavy-format document, enqueue through real task-runner, assert exactly one launch and final extraction. Existing firestore-document-processing.test.ts95–123 injects config directly; firestore-full-composition.test.ts168–204 only constructs/registers tools/sweeps and does not cover this chain. These tests were inspected, not executed.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/deps.ts#L606-L627), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/document-processor.ts#L211-L221), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/deps.ts#L337-L367)

### APP-04: Local PostgreSQL sweep still aborts maintenance after owner-read failure

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Local PostgreSQL sweep still aborts maintenance after owner-read failure

**Required improvement:** share one maintenance implementation across transports; isolate owner-dependent steps and continue independent ones. Regression: getAgent rejects while expiry/purge is healthy; assert all independent steps still run and error receipt names failed step.

**Acceptance to establish:** getAgent rejects while expiry/purge is healthy; assert all independent steps still run and error receipt names failed step.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/poller.ts#L75-L116), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/poller.ts#L176-L193)

### AUX-MAPS-SPORTS: Sports/maps must preserve coverage, historical scope, transport mode and trusted image hosts

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Provider data may be missing, historical, contain a lookalike logo host, or return a transport mode different from the request. Empty/fallback results can conceal incomplete coverage.

**Required improvement:** Preserve source coverage/date/mode and use parsed exact host boundaries; do not label a fallback as the requested current/historical result.

**Acceptance to establish:** Use roster/scoreboard failure, requested historical date, lookalike host and walking/cycling versus automobile fixtures; visible/spoken results preserve unknowns and actual transport.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/sports/espn.ts#L93-L102), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/sports/lookup.ts#L139-L188), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/maps/apple.ts#L97-L105), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/realtime-voice/openai.ts#L110-L133), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/realtime-voice/gemini.ts#L259-L275), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/audit-capture.ts#L26-L65), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/audit-graders.ts#L369-L389), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/calendar-module.ts#L11-L23), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/application-confirmations.ts#L530-L570)

### AUX-TOOLS-MCP: MCP stream matching and ambiguous effects need an explicit transport contract

**Current status:** Partial; source changes and focused checks.

**Observed condition:** MCP SSE can contain notifications before its matching JSON-RPC response, remain open, or lose a response after the remote effect happened. Current parsing/ordinary error shape does not establish request matching or a safe retry.

**Required improvement:** Match response IDs under bounded streaming deadlines; separate notification handling and typed unknown-effect outcomes. Require remote idempotency or reconciliation for mutations.

**Acceptance to establish:** Send notification-first, wrong-ID, split-frame and open-stream fixtures; simulate accepted remote mutation with lost reply. Exactly the matching reply settles; no blind duplicate mutation follows uncertainty.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/mcp.ts#L280-L295)

### AUX-TOOLS-READS: Source reads need loss, structure, pagination and completeness receipts

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Several supported reads discard tables, additional sheets, long thread/source tails or next-page tokens while returning a success-shaped result. Callers cannot recover evidence discarded before persistence.

**Required improvement:** Define source handles, structure, requested/covered ranges, truncation and pagination consistently; preserve readable continuations and honest partial outcomes.

**Acceptance to establish:** Place decisive facts after every read boundary and in tables/secondary sheets. Retrieve them through continuation or explicitly report unsupported/partial coverage; never claim a full source read.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/docs.ts#L30-L53), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/gmail.ts#L124-L132), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/drive.ts#L22-L50)

### FS-04: Gmail's expiring lock does not fence the worker it replaces

**Current status:** Partial; source changes and focused checks.

**Observed condition:** email-sync.ts122–143 leases one lock for ten minutes with no renewal or token propagation; only final lock deletion checks holder. saveCursor105–109, raise80–99, completeDrain111–112 and external sync work do not check that holder is still current. If a sync exceeds ten minutes, a second run acquires the lock and both proceed; a late first-worker saveCursor can overwrite a newer cursor or recreate a cleared drain cursor. Monotonic lastHistoryId protects baseline regression but not cursor, triage budget admission, or external actions. Fix: renew the lease and require exact lock token/generation on every state mutation, check before side effects, or use task-scoped fencing with resumable drain ownership. Test with a deterministic paused first run past LOCK_MS, allow the second run to advance/clear state, then resume the first; no stale mutation or extra admission may commit. No provider calls or test execution were performed.

**Required improvement:** renew the lease and require exact lock token/generation on every state mutation, check before side effects, or use task-scoped fencing with resumable drain ownership. Test with a deterministic paused first run past LOCK_MS, allow the second run to advance/clear state, then resume the first; no stale mutation or extra admission may commit. No provider calls or test execution were performed.

**Acceptance to establish:** Pause the first Gmail sync beyond its lease, let a second holder advance/clear state, then resume the first. Stale holder cannot overwrite cursor, recreate work or admit extra effects.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/email-sync.ts#L80-L143)

### FS-18: Lifetime-history bounds make owner cleanup and live views fail on ordinary growth

**Current status:** Partial; source changes and focused checks.

**Observed condition:** goal-mutations.ts430–440,473–479 counts all goal task history against200 before filtering terminal tasks;201 completed runs block abandon/archive. Pause remains available, so this is not proof that every stop path is blocked generated-cards.ts245–263 counts status-active rows against200 before excluding expiresAt;201 expired but undismissed cards can break the live card list despite zero current cards. This repository only transitions status on explicit dismissal; expiry itself is a read predicate workspace-anomalies.ts72–82 and workspace-improvements.ts211–221 fail above2,000 total owner rows even if all older rows are dismissed/applied. Tests intentionally demonstrate this lifetime-history failure task-activity-commands.ts197–220 refuses archive-old if >400 eligible rows, with no cursor or partial batch. The cleanup intended to reduce history cannot process an ordinary accumulated backlog

**Required improvement:** query the live predicates before limits, separate immutable history from current state, use paginated resumable owner operations with durable progress, and expose bounded continuation. Preserve atomic safety invariants per batch rather than weakening checks. Proposed tests: at/above each boundary with only historical rows, a small live set behind them, >400 archival candidates, and retries after partial progress; verify safety actions remain accessible and counts honest.

**Acceptance to establish:** at/above each boundary with only historical rows, a small live set behind them, >400 archival candidates, and retries after partial progress; verify safety actions remain accessible and counts honest.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/goal-mutations.ts#L430-L479), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/generated-cards.ts#L245-L263), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/workspace-anomalies.ts#L69-L89), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/workspace-improvements.ts#L208-L228), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/task-activity-commands.ts#L197-L220), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/goal-mutations.ts#L250-L263)

### FS-19: Supported large documents become unreadable in the owner detail view

**Current status:** Partial; source changes and focused checks.

**Observed condition:** FS-19: Supported large documents become unreadable in the owner detail view (medium severity, high confidence, new)

**Required improvement:** paginated chunk detail with stable chunkIndex cursor, response byte bound and declared total; align all producer/consumer capacity contracts. Proposed tests:1,000,1,001 and4,000 chunks, stable pagination and owner checks; ensure ready document metadata remains viewable even when chunk content requires additional pages.

**Acceptance to establish:** 1,000,1,001 and4,000 chunks, stable pagination and owner checks; ensure ready document metadata remains viewable even when chunk content requires additional pages.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/documents.ts#L43-L47), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/documents.ts#L89-L115), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/document-extraction.ts#L333-L342), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/documents.ts#L154-L164)

### HC-06: Mail lookup coverage conflates found hits with inspected answer evidence

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Gmail search reports complete based on whether the metadata search returned all matches, not whether their bodies were read: gmail.ts:74–105 The runtime always selects only the first three distinct thread IDs: read-intent.ts:990–1022 Required-read completion checks only those three, not whether the user's requested fact was resolved: read-intent.ts:1045–1087, response-contract.ts:1068–1095 After that, the model is forced into answer-only mode and any extra calls are dropped: step-loop.ts:579–598, step-loop.ts:811–828,1033–1037 The deterministic partial-mail notice keys off search.complete=false, so complete metadata with unread fourth/fifth bodies has no equivalent coverage flag: response-contract.ts:2098–2105

**Required improvement:** Return requested, discovered, actually read and unavailable email evidence distinctly; provide bounded continuations and avoid declaring complete mailbox/thread inspection from search hits alone.

**Acceptance to establish:** Five complete search hits, answer only in fourth body: refine/select more relevant evidence within budget or explicitly report the uninspected scope First three hits same stale trip, fourth current trip: do not confidently substitute the old stay Complete zero-match search: report the scoped negative, optionally reformulate when request semantics warrant it Partial page of metadata: no “all” claim Metadata snippets suffice for a simple sender/subject question: no unnecessary body reads Exhaustive history request: bounded result must explicitly state what was searched/opened and what remains A larger thread cap alone must not be accepted as the fix; use relevance and answer sufficiency

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/gmail.ts#L74-L105), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/read-intent.ts#L990-L1022), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/read-intent.ts#L1045-L1087), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L1068-L1095), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L579-L598), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L811-L828), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L2098-L2105), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L150-L175), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1161-L1192), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L232-L280), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1147-L1192), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1429-L1447), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L300-L418), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1385-L1409), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L1122-L1135), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/read-intent.ts#L103-L128), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/read-intent.ts#L150-L153), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L2249-L2268), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L406-L412)

### MC-08: Supported embedding dimensions are rejected by the common router

**Current status:** Partial; source changes and focused checks.

**Observed condition:** a valid Firestore embedding space configured at 768 (or another supported non-1536 width) is used through ModelRouter.embed.

**Required improvement:** pass immutable expected embedding-space identity and dimensions into every embedding operation; validate against that space, with explicit separate PostgreSQL fixed-vector restrictions. Never accept mixed spaces merely because dimensions match, and never silently re-embed under another provider.

**Acceptance to establish:** complete configuration→provider→ModelRouter→persistence flow for 768 and 1536, invalid cardinality/nonfinite vectors, model/revision mismatch and disabled model. Assert no repeated paid regeneration for deterministic width mismatch.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/config/src/index.ts#L357-L368), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/provider.test.ts#L129-L138), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1701-L1724), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1634-L1679), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L711-L735)

### MC-09: SMS budgets count one unit regardless of multipart encoding

**Current status:** Partial; source changes and focused checks.

**Observed condition:** an outgoing body occupies multiple provider segments; Unicode punctuation and non-GSM text make text length alone insufficient.

**Required improvement:** centralize encoding-aware conservative segment estimation for both tools and channel replies, freeze prepared final body before reservation, retain SID and reconcile provider-reported segments/price when available; distinguish submitted message count from billed segment count. Keep ambiguous acceptance bounded rather than retrying it.

**Acceptance to establish:** GSM boundary, extension-table characters, emoji/non-Latin text, long1500-character body, voice rewrite expanding/changing encoding, accepted and ambiguous sends; compare reservation, receipt, and reconciled segment quantity.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/sms/channel.ts#L66-L121), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/sms/channel.ts#L220-L262), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/twilio/sms.ts#L22-L79), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/sms/meta.ts#L15-L23), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/twilio/sms.ts#L70-L79), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/sms/channel.ts#L220-L236)

### MC-15: Email attachment path collisions overwrite or delete referenced bytes

**Current status:** Partial; source changes and focused checks.

**Observed condition:** a single email contains same-named or sanitization-colliding attachments. Distinct contents overwrite the earlier attachment's referenced file; identical contents can trigger duplicate cleanup that deletes the already referenced same path.

**Required improvement:** include stable attachment identity or content digest in the workspace key, avoid overwriting existing referenced bytes, and delete only an object proven newly created for a duplicate attempt. Keep dedupe/provenance owner-scoped.

**Acceptance to establish:** same name with different bytes, same name with identical bytes, names that sanitize identically, replay, and concurrent filing; assert every surviving catalog file hash matches stored bytes and no live reference is deleted.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L515-L557), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/document-catalog.ts#L39-L114), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L1058-L1128), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L927-L1031), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L629-L693)

### PROV-01: Recoverable investigation failures become terminal

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Impact: a short provider outage can permanently stall an authorized repair until the owner retries manually. Existing automatic allowance recovery only helps queued reports. A model-budget result is also reduced to a generic exception at self-repair.ts:259–260 instead of retaining the reason and resume time.

**Required improvement:** persist a typed pre-dispatch outcome, next eligible time, retry count, accumulated cost/request count, and explicit owner-action reason. Recover only safe pre-dispatch transient states. Keep authorization/configuration failures blocked with a concrete action. Keep ambiguous coding dispatch in its existing reconciliation path; never redispatch based on a generic retry flag.

**Acceptance to establish:** Exhaust safe pre-dispatch transient retries, persist next eligible wake and restart. Recover after outage without losing the issue; auth/config blocks remain actionable and ambiguous coding dispatch is reconciled rather than repeated.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.ts#L314-L326), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/persistence/src/self-repair.ts#L136-L168), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/repair-schedule.ts#L34-L42), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.ts#L214-L253), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.ts#L314-L332), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.ts#L119-L133), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.ts#L233-L256), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.ts#L337-L357)

### PROV-02: Router and repair triage both own fallback, masking the recovery cause

**Current status:** Partial; source changes and focused checks.

**Observed condition:** router.ts:1580–1607 already tries a distinct fallback for capability or structured-output failure. If it fails, the catch omits the fallback exception from the propagated error and rethrows the primary exception. self-repair.ts:233–256 then implements another fallback without knowing which routes ran internally. This is a control-flow and RepairIssue.lastError loss, not proof that all diagnostic evidence is lost: the per-attempt catch at 1549–1572 calls recordFailureForAudit, whose implementation at 1048–1074 includes the model, error, and status. That evidence is capture-mode-dependent and best-effort: recordForAudit at 1014–1044 returns when capture is off and contains write failures.

**Required improvement:** give one layer ownership of the total attempt policy. Return/throw structured attempt evidence containing route, model, request profile, failure kind, elapsed time, and whether fallback was already attempted. Preserve the original cause for diagnostics and the last/fallback cause for recovery decisions. Do not replace one with the other. Honor successful output's modelId/degraded when deciding whether another model is available.

**Acceptance to establish:** Compose real router and repair logic for primary capability failure, fallback timeout/outage/invalid brief and nearly expired deadline. One shared bounded attempt policy retains every cause and never repeats an already-used fallback unknowingly.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1580-L1607), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.ts#L233-L256), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1549-L1572), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1048-L1074), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1014-L1044), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.test.ts#L85-L104), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.ts#L214-L253), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.ts#L314-L332), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.ts#L119-L133), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.ts#L314-L326), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L687-L753), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L594-L620), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.ts#L337-L357), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L138-L154), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1301-L1317), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1577-L1625), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L883-L978), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L899-L917), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L760-L894), [reference 20](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L537-L553), [reference 21](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L811-L834), [reference 22](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L919-L1005), [reference 23](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1361-L1410), [reference 24](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L600-L640), [reference 25](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L475-L512)

### PROV-03: Capability metadata does not validate the actual request shape

**Current status:** Partial; source changes and focused checks.

**Observed condition:** provider.ts:177–209 enables require_parameters and constructs model-specific reasoning options. router.ts:687–753 reads only thinking from capabilities; it does not receive a structured-output/tool/stream request profile. model-providers.ts:493–506 imports only reasoning support from supported_parameters, then lines 604–611 assume tools, JSON, and streaming are supported.

**Required improvement:** describe required capabilities per call, persist verified capability metadata and freshness, validate both configured routes, and test the actual serialized request profile. Distinguish JSON mode from JSON-schema support and mandatory reasoning from an optional off switch. Preserve require_parameters, privacy restrictions, required tools/schema semantics, and cost limits. Do not “recover” by silently dropping required constraints. Catalog checks are advisory; a synthetic request is needed to prove the combination works.

**Acceptance to establish:** Test the actual serialized tool-choice, JSON-schema, stream, reasoning, privacy and price constraints on every eligible primary/fallback. Do not pass by dropping required semantics.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/provider.ts#L177-L209), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L687-L753), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/model-providers.ts#L493-L506), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/model-providers.ts#L604-L611), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/model-config.ts#L108-L125), [reference 6](https://openrouter.ai/docs/guides/routing/provider-selection), [reference 7](https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1580-L1607), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1549-L1572), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1048-L1074), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1014-L1044), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L594-L620), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L138-L154), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1301-L1317)

### PROV-04: Raw, misleading, non-actionable repair notices

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Before dispatch, retry scheduled: “I couldn't start the investigation because the AI service is temporarily unavailable. I'll retry at [time].” Only say this after the wake is durably committed Unsupported request shape, no verified route: “The investigation is blocked by the model setup. No coding run started. Review the model connection in Settings.” Provide an app link to the relevant setting/report Exhausted authorized attempts: “I couldn't complete the investigation after the allowed retries. The report is saved for review.” Expose Retry or Run now according to existing rules Unknown external dispatch: “I'm checking whether the coding run started.” Do not claim a fresh run was launched Keep PR/merge/deployment/confirmed-fixed as distinct, evidence-backed stages

**Required improvement:** generate deterministic, stage-aware summaries from the typed outcome. Examples

**Acceptance to establish:** Inject failures at investigation, coding dispatch, PR, merge, rollout and verification stages. User copy names the real stage and next step without raw provider errors or an unsupported fixed/deployed claim.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/self-repair.ts#L17-L32), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/owner-text.ts#L196-L228)

### PROV-05: Error classification traversal is artificially shallow

**Current status:** Partial; source changes and focused checks.

**Observed condition:** isProviderCapabilityError:594–620 permits four queue iterations, counting undefined entries and already-seen objects. For a wrapper with only errors: [unrelatedError, capabilityError], root + undefined lastError + undefined cause + first child exhaust the limit; the real capability error is not visited. The repair-local classifier repeats this pattern with eight iterations at self-repair.ts:337–357.

**Required improvement:** a shared cycle-safe bounded walker should count actual objects, enqueue only object candidates, and impose explicit node/depth limits. Normalize numeric/string status fields and SDK-supported error markers. Give authentication/authorization denials priority over incidental message substrings. Keep unrelated application errors out of provider recovery.

**Acceptance to establish:** Walk nested SDK errors with undefined fields, multiple sibling errors, numeric/string status, cycles and depth limits. Recognize the relevant cause without treating unrelated application errors as provider failures.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L594-L620), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.ts#L337-L357), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.ts#L214-L253), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.ts#L314-L332), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.ts#L119-L133), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.ts#L314-L326), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1580-L1607), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/self-repair.ts#L233-L256), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1549-L1572), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1048-L1074), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1014-L1044), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L687-L753), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L138-L154), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1301-L1317)

### R11: Grounding validates a bag of facts rather than the relationships the answer claims

**Current status:** Partial; source changes and focused checks.

**Observed condition:** 1. Calendar factual grounding builds one vocabulary and one set of minute-of-day boundaries from all returned events (response-contract.ts:1690–1734), then separately checks title presence and whether each clock belongs to any event (1745–1782). With Dentist09:00 and Interview15:00, “Dentist15:00; Interview09:00” passes these checks. Date, event identity, location and clock are not joined. Any earlier availability phrase exempts subsequent clocks because line1771 searches the entire preceding prose 2. The free-time check's comment correctly says a named search cannot establish hours around a match, but its condition checks only request.timeWindow && !incomplete (1789–1794). A complete calendar.search_events(query='dentist') within tomorrow's window can therefore license “you are free afterward” despite excluded unrelated events. Test 1910–1916 explicitly accepts an unseen16:00 free-time statement from one event listing 3. Action support is category-level: any successful send supports outbound, any calendar create/update/cancel/delete supports calendar, and append/share/download can support a document mutation claim (321–369). A genuine send to Alice can support a claim that Bob was emailed; a cancellation receipt can support “I added it to your calendar.” Single-outcome turns have no compound checklist to catch target mismatch

**Required improvement:** canonical typed facts carrying object ID, operation, recipient, time interval, calendar coverage/query, metric/unit, and source references. Validate individual claims against a single corresponding record. Prefer a deterministic verified summary when natural-language claim matching cannot establish this relationship; do not strengthen a claim merely because the words/numbers appeared somewhere.

**Acceptance to establish:** swapped two-event times/venues/dates; same clock on different days; named search plus unrelated conflicting event; availability phrase before an invented agenda time; send toA/claimB; cancel/claimcreate; one send/claimthree; temperature sign/unit/current-vs-high swaps; scorewinner swap and15/42 versus5/4. Existing tests cover fabricated isolated names/times and stale evidence, leaving these relational counterexamples uncovered.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L1690-L1734), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L1745-L1782), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L1789-L1794), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.test.ts#L1910-L1916), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L321-L369), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/live-lookup.ts#L584-L609), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/live-lookup.ts#L274-L308), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/live-lookup.ts#L320-L339), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/live-lookup.ts#L464-L466), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L1745-L1748), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L1970-L1974), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L854-L870), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L897-L905)

### R15: Complete calendar answers silently drop rows and all-day dates can shift

**Current status:** Partial; source changes and focused checks.

**Observed condition:** groundReadDraft refuses to publish an agenda exceeding its small shape limit (response-contract.ts:1745–1748), but its supposedly complete deterministic replacement silently emits only the first20 events (1970–1974). Provider completeness does not disclose this presentation omission. An owner asking for the full calendar can miss event21 even though retrieval succeeded. Briefing cards separately cap10 agenda items while preserving complete:true (briefing-card.ts:128–136); their text warning appears only for provider failure. A salient event outside the first10 can trigger a digest but be absent from the actual schedule section.

**Required improvement:** distinguish source coverage, display count and omitted count. Provide pagination or an explicit bounded preview plus total and continuation, and preserve salient items under the bound. Represent all-day dates as civil dates; never derive their day by converting an arbitrary instant across zones.

**Acceptance to establish:** 13/20/21/50-event complete reads, the only salient/conflicting event after the display cap, empty partial calendar, UTC+12/+13/+14 and UTC−12 all-day events, multi-day exclusive ends. Current tests use small calendars and California; they do not assert display completeness.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L1745-L1748), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L1970-L1974), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing-card.ts#L128-L136), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/briefing-card.ts#L107-L110), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L1690-L1734), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L1745-L1782), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L1789-L1794), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L321-L369), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L854-L870), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L897-L905)

### R16: URL provenance treats distinct resource addresses as equivalent

**Current status:** Partial; source changes and focused checks.

**Observed condition:** source contains final URL passes by prefix, even though it is a different resource. Source /DocAbC can license /docabc, or a trusted URL can license a different port. Arbitrary query parameters can change the resource or action while test1602–1609 deliberately allows a benign tracking query. The implementation cannot distinguish those cases.

**Required improvement:** extract actual source URLs into parsed records, preserve path/query/port semantics and case-sensitive identifiers, and require full canonical equality. Allow only explicitly enumerated inert tracking parameters to be dropped. Constructed provider links need provider-specific schema and exact IDs, not a segment-length heuristic.

**Acceptance to establish:** path prefixes, case changes, nondefault ports, query resource identifiers, Google short IDs, fragments whose app routing is meaningful, and approved tracking-parameter normalization. Keep labels when rejecting unverifiable links, as the existing behavior already does.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L854-L870), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L897-L905), [reference 3](https://example.test/report/123), [reference 4](https://example.test/report/12?record=other), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L1690-L1734), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L1745-L1782), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L1789-L1794), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L321-L369), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L1745-L1748), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/response-contract.ts#L1970-L1974)

### TW-01: Code callback limits exceed the receiving webhook limit

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A script writes sufficiently large stdout/stderr. Each stream permits 256 * 1024 JavaScript string units, and both are embedded in a single JSON callback. Two ASCII streams at their caps already exceed the agent's 512 KiB body limit after framing; non-ASCII expands bytes further

**Required improvement:** Measure UTF-8 bytes of the complete callback envelope, reserve framing overhead, truncate/stream output with explicit truncation metadata, and persist oversized logs as bounded artifacts

**Acceptance to establish:** Both streams at cap; multibyte Unicode; JSON escaping; oversized goal/path metadata; callback <= configured byte budget; preserve exit status and all output handles

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L161-L183), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/agent/src/routes/webhooks.ts#L25-L33), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L132-L140), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L111-L119), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/code-runner/src/index.ts#L97-L119)

### TW-05: Spreadsheet/PPTX extraction drops structural meaning

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Sparse spreadsheets and presentations whose slide order was edited can be summarized/indexed in the wrong relational or narrative order even though extraction reports success

**Required improvement:** Preserve cell coordinates/blank positions and stable sheet dimensions; follow the presentation's ordered slide-ID relationship list; carry extraction completeness/structure metadata

**Acceptance to establish:** Missing leading/interior cells, merged/header cells, reordered slide relationships whose part filenames are unchanged, and text assertions tied to the original positions

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/document-processor/src/extract.ts#L64-L76), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/workers/document-processor/src/extract.ts#L79-L95)

### TW-10: Provider deadlines stop short of complete response consumption

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Provider deadlines stop short of complete response consumption

**Required improvement:** Bound the entire transaction, including body read, with a combined caller/deadline signal; cap response bytes; settle every HTTP/2 termination path; preserve unknown-effect state rather than retrying potentially accepted sends

**Acceptance to establish:** Headers arrive then body stalls, partial body then abort, stream close without end, session GOAWAY after provider acceptance, deadline during retry sleep, and no duplicate effect on recovery

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/twilio/client.ts#L203-L218), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/client.ts#L299-L314), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/push/apns.ts#L110-L156)

### TW-14: Calendar coverage can be reported complete after dropping requested calendars

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Request A+B while B is absent/unreadable and A succeeds. Output can claim complete:true without identifying B as unavailable, permitting an incomplete schedule/free-time answer

**Required improvement:** Preserve requested versus resolved versus searched sets, name unresolved selections, propagate roster nextPageToken/truncation and expose stable pagination for remaining events

**Acceptance to establish:** Some/all requested calendars missing; duplicate/display-name collisions; deleted/revoked calendar; paginated roster; fanout cap; individual event-page truncation. Existing tests cover a failing calendar only when it remains in the roster, not an omitted requested calendar

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/calendar.ts#L189-L255), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/calendar.ts#L287-L315), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/calendar.ts#L698-L731)

### TW-15: Calendar attendee updates lose fields and can target the wrong shared-calendar identity

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Adding a guest can reset existing guest metadata. On a writable shared calendar whose self row belongs to a third party, RSVP code can act for that calendar owner rather than the configured owner/bot. The source comment itself notes self is calendar-relative; no live API action was performed Provider semantics independently checked: Google's Events resource defines attendee self relative to the calendar containing that event copy, not as a blanket assertion that it is the configured assistant/owner identity

**Required improvement:** Preserve existing attendee rows keyed by normalized address; only add new rows. Bind RSVP actor to an explicitly authorized identity/calendar relationship, treating self only as evidence within that verified scope. Apply ETag/revision preconditions to owner-only checks and read-modify-write arrays so concurrent guest changes cannot invalidate the authority check or be overwritten

**Acceptance to establish:** Existing RSVP/optional/comment fields survive additions; owner+bot+foreign self row; writable nonowner calendar; guest added between verification and PATCH/DELETE; concurrent RSVP edit; missing/both identities

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/calendar.ts#L287-L315), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/calendar.ts#L698-L731), [reference 3](https://developers.google.com/workspace/calendar/api/v3/reference/events), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/calendar.ts#L189-L255)

### TW-16: Slides “append” prepends new slides

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Appending to a nonempty presentation inserts the new batch at the front, violating the requested order and tool description

**Required improvement:** Omit insertionIndex when provider appends by default, or obtain and revision-fence the existing count and pass an offset. Keep create ordering separate

**Acceptance to establish:** Existing deck[A,B] append[C,D] yields[A,B,C,D]; empty deck; concurrent edit; replay preserving one batch. Current slides.test.ts covers create and registration only

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/slides.ts#L64-L75), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/slides.ts#L241-L250), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/slides.ts#L227-L253)

### TW-17: Drive ingestion and attachment staging reuse mutable filenames

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Drive ingestion and attachment staging reuse mutable filenames

**Required improvement:** Immutable content-addressed or ingestion-attempt paths, atomic catalog attachment, generation-fenced cleanup of only newly owned objects, and approved upload receipts containing digest/size/version. Keep explicit user revisions linked rather than overwriting historical evidence

**Acceptance to establish:** Same-file unchanged reingest, changed-content same name, different IDs with same/sanitized-colliding names, duplicate versus new catalog outcomes, catalog failure, concurrent runs, and an approved upload after a replacement attempt

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/drive.ts#L291-L320), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/drive.ts#L101-L110), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/drive.ts#L22-L50), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/drive.ts#L250-L258)

### TW-19: Native Google Sheets reading/ingestion silently exports only the first worksheet

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A native Google spreadsheet has multiple tabs. Only the first tab is read/indexed, but the result identifies the whole spreadsheet and truncated reflects only string length. Important information on other tabs is absent without any incompleteness signal

**Required improvement:** Enumerate sheets and read bounded typed ranges per tab with a manifest, or export a topology-preserving workbook and process all sheets. Return explicit per-tab completeness, limits and continuations

**Acceptance to establish:** Two tabs with distinct key facts, hidden/empty/large tabs, renamed/reordered tabs, CSV-export fallback, and queries whose only answer is on a later tab. No provider request/test was executed

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/drive.ts#L22-L50), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/drive.ts#L250-L258), [reference 3](https://developers.google.com/workspace/drive/api/guides/ref-export-formats), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/drive.ts#L291-L320), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/google/drive.ts#L101-L110)

### VH-03: Call interruption accounting estimates playback without transport acknowledgments

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The bridge estimates queued audio from bytes/time and clears output, but does not consume Twilio marks. It cannot establish exactly which generated audio played from that clock alone.

**Required improvement:** Add per-output playback marks, clear-versus-played accounting, bounded queues and generation fences. Distinguish transport playback from human comprehension.

**Acceptance to establish:** Interrupt or clear audio before/during/after marks, reorder events and reconnect. Spoken-offset/truncation state must match acknowledged transport behavior without treating playback as understanding.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/calls/bridge.ts#L115-L639), [reference 2](https://www.twilio.com/docs/voice/media-streams/websocket-messages)

### APP-02: Withdrawn candidate: Firestore Shortcut location is intentionally unsupported

**Current status:** Withdrawn; intentionally unsupported.

**Observed condition:** Supported Firestore configuration rejects the Shortcut-location secret and canaries; the suspected SQL route is not reachable in a supported profile.

**Required improvement:** Withdraw the runtime-defect claim. Port the feature only if deliberately added to the supported profile and its composition contract.

**Acceptance to establish:** If later enabled, validate configuration→HTTP→application→Firestore behavior; current supported configuration must continue to reject the unsupported combination.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/config/src/index.ts#L436-L478)

### HM12: Deterministic hotel cards copy secret-bearing mail into an unmasked fact

**Current status:** Partial; source changes and focused checks.

**Observed condition:** generative-card.ts 719–776 bypasses model composition and validateGroundedCard when one short email contains check-in. It copies the entire body into a details fact with no sensitive value, whose schema default is false (7–13). Booking/access codes anywhere in that body are now public card values. Historical projection only flags private-looking fact ID/label or sensitive=true; details / Reservation details do not qualify (conversation-context.ts 13–14,31–45). Situation snapshots likewise include any false-sensitivity fact (situations.ts 63–69).

**Required improvement:** use a shared field classifier/secret policy for deterministic and model-generated cards, split bounded identified facts rather than copying a whole email, and propagate sensitivity through every title/summary/value/source projection and export. A source label must not itself confer trusted fact status.

**Acceptance to establish:** <=500-character confirmation containing check-in plus booking PIN/reference, door code, bearer link or account identifier; assert no sensitive value in default card, historical context, situation snapshots, share output or accessibility text until deliberate reveal.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/generative-card.ts#L719-L776), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/conversation-context.ts#L13-L45), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/situations.ts#L63-L69), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/generative-card.ts#L448-L454), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/generative-card.ts#L559-L566)

### IOS-01: Transcription failure bypasses microphone teardown

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A transcription-result stream fails after recording has started. ChatView clears the mic latch and calls reset(), visually returning to idle, without stopping the engine. TalkView tries leave(), but stop() exits because state is unavailable. The engine/tap can remain live while the UI says it is off. A separate startup failure after installTap but before engine.isRunning also misses tap removal, risking a poisoned retry. Exact audio/OS symptoms require device validation.

**Required improvement:** Make teardown resource-based/idempotent regardless of presentation state; finalize cleanup on stream failure and deinit; generation-fence tasks.

**Acceptance to establish:** Inject result-stream error while engine running, dismiss, assert tap removed, engine stopped, audio session inactive; repeat start without duplicate tap.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/System/SpeechListener.swift#L119-L175), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/System/SpeechListener.swift#L177-L227), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/ChatView.swift#L2135-L2145), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/TalkView.swift#L147-L151), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/ChatView.swift#L568-L598), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/ChatView.swift#L2033-L2145), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/ChatView.swift#L1934-L1999), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/System/SpeechListener.swift#L177-L207), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/TalkView.swift#L233-L266)

### IOS-03: Undo-hide can publish stale conversation across navigation/account changes

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Hide a durable row, tap Undo, and delay the conversation reload. While it is pending, navigate to another chat, pair another assistant, or send a new turn. The old response unconditionally invokes setActiveConversation, replacing messages/cursor and stopping speech. The ordinary new-turn race does not require account-ID collision; cross-account stale display is also possible if pairing occurs while the GET is pending.

**Required improvement:** Capture connection epoch, owner, conversation, navigation intent; check after every await before publishing. Preserve undo outcome separately from active navigation.

**Acceptance to establish:** Delay unhide GET, navigate B or pair new owner, release old response; no old rows/cursor/navigation overwritten.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L1298-L1318), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2735-L2746), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2803-L2821), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2636-L2661), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2832-L2843), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2896-L2919), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2949-L2966), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L750-L801), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L403-L429), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L678-L703)

### IOS-06: Foreground location opt-out is not rechecked before transmission

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Enable location sharing, begin the bounded fix/reverse geocode, then turn sharing off before it resolves. The current call checks connection identity after capture but never rechecks the sharing toggle and can still POST a precise location. The opt-out UI only disables background monitoring; it does not cancel an in-flight foreground capture.

**Required improvement:** Capture opt-in generation and owner/scope, check consent again immediately before POST; cancel pending fixes on off.

**Acceptance to establish:** Begin capture, disable sharing before fix/geocode completes, assert no ping.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L678-L703), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/MoreView.swift#L157-L195), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2803-L2821), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L1298-L1318), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2735-L2746), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2636-L2661), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2832-L2843), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2896-L2919), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2949-L2966), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L750-L801), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L403-L429)

### IOS-09: Latched composer dictation has no background stop

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Tap the microphone to latch dictation, then Home/lock the phone. The screen may remain mounted and no scene handler stops dictation. The audio background mode permits continued recording. Unlike Talk mode, there is no explicit leave-on-background contract. Verify on hardware, but the missing cleanup path is established from source.

**Required improvement:** Stop/cancel dictation and invalidate setup generation on background, screen lock/interruption; preserve draft and require explicit restart.

**Acceptance to establish:** Tap-latch then Home/lock/control interruption; assert no audio input or transcription continues and no automatic reopening on resume.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/ChatView.swift#L568-L598), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/ChatView.swift#L2033-L2145), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Info.plist#L39-L51), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/ChatView.swift#L2135-L2145), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/ChatView.swift#L1934-L1999)

### IOS-10: Automatic speech bypasses approval privacy projection

**Current status:** Partial; source changes and focused checks.

**Observed condition:** With Speak replies aloud enabled, a durable approval-bearing assistant message has nonempty private prose. finishSpeaking calls SpeechProgress.take on that prose first; it marks hasSpoken and prevents the protected full-message helper from running. Streamed blocks also bypass the helper. The standalone privacy unit test therefore does not prove the automatic speech path safe.

**Required improvement:** Use one typed privacy-aware speech projection across automatic/manual/stream paths, know safe speech classification before speaking; do not infer from absent later cue.

**Acceptance to establish:** Opt-in automatic speech plus approval text with private fields, streamed and durable paths: only decision announcement, no private payload. Tests at SpeakableTextTests 83-96 only exercise standalone helper.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2803-L2821), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/SpeakableText.swift#L27-L36), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/AssistantTests/SpeakableTextTests.swift#L83-L96), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/SpeakableText.swift#L176-L195), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L1298-L1318), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2735-L2746), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2636-L2661), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2832-L2843), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2896-L2919), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2949-L2966), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L750-L801), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L403-L429), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L678-L703)

### IOS-11: Generated-card sensitivity is not enforced on secondary fields or accessible speech labels

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A card marks a progress total, label, countdown label, or score fact sensitive. Native blocks still render those secondary values directly. Separately, an accessibilityLabel containing a hidden reference is bound and spoken verbatim before filtering facts. Hidden-value policy is enforced at some leaves rather than over the entire presentation. The compiler may compound the problem; this report establishes the native bypass even when sensitive flags are present.

**Required improvement:** Centralize fact access as visible/revealable rather than raw strings; enforce sensitivity on every referenced value and generated title/subtitle/labels/speech; generate safe a11y projection deterministically.

**Acceptance to establish:** Render progress with sensitive totalFact and labelFact; countdown with sensitive labelFact; card accessibilityLabel containing hidden reference must not expose it to screen reader or automatic speech.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/GeneratedCardBlocks.swift#L250-L275), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/GeneratedCardBlocks.swift#L327-L337), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3765-L3773), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/SpeakableText.swift#L176-L195), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1617-L1624), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3593-L3596), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/SpeakableText.swift#L27-L36), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/GeneratedCardBlocks.swift#L528-L575), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L4798-L4806), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1464-L1484), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1528-L1543), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L2702-L2714), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1336-L1344), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3511-L3513), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3227-L3245), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3305-L3313), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1436-L1443), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1549-L1560), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3660-L3675), [reference 20](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3750-L3762)

### API-08: Coalescing can return a pre-mutation snapshot to a post-mutation refresh

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Read A obtains an old approvals/settings section but is still waiting on another section. A mutation commits. Refresh B starts afterward and joins A, receiving the old section. No-store and discarding settled promises do not establish read-your-writes consistency. The helper's “can never serve stale data” comment is stronger than its actual guarantee. The owner can see an already-decided approval or old setting after a successful change.

**Required improvement:** Invalidate or advance a read generation when a mutation commits, let post-mutation refreshes require a minimum revision, or bypass coalescing for that refresh. Avoid globally caching errors or sharing across installation identities if the singleton assumption changes.

**Acceptance to establish:** Deferred A reads old state; mutation commits; B begins; A finishes. Assert B observes the mutation or explicitly receives a stale/retry receipt. Existing coalesce.test.ts tests overlap and post-settlement freshness but not a write between readers.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/lib/coalesce.ts#L12-L19), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/overview/route.ts#L26-L61), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/workspace/route.ts#L33-L37), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/lib/coalesce.test.ts), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/workspace/route.ts#L42-L66)

### DESIGN-COMPOSITION: Bounded native component composition with server-owned actions

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Existing generated cards have useful native primitives and grounded revisions, but limited general input, bounded composition, stable draft identity and interaction semantics.

**Required improvement:** Extend the app-owned typed component catalog, source/draft/view/execution state and server action references; negotiate capabilities and safe text fallbacks.

**Acceptance to establish:** Compose an unfamiliar workflow without a domain-specific renderer; survive reorder/refresh/reconnect, reject stale/double actions, preserve required warnings and accessibility, and never mutate during render.

Source references: [reference 1](https://github.com/bmson/assistant/tree/ce348d48ef0a9629907873e79c0c97a9ed891f11), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/generative-card.ts#L7-L189), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/generative-card.ts#L695-L843), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/generative-card.ts#L380-L457), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/finalize.ts#L569-L737), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/generative-card.ts#L942-L1027), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/persistence/src/generated-cards.ts#L1-L50), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/cards.ts#L35-L151), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat.ts#L376-L430), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L984-L1139), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3511-L3867), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/GeneratedCardBlocks.swift#L1-L41), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/CardActions.swift#L60-L151), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/response-card.tsx#L1338-L1727), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/proxy.ts#L7-L36), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/design-system.md), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/generative-ui.md), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1563-L1570), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/GeneratedCardBlocks.swift#L460-L507), [reference 20](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/GeneratedCardBlocks.swift#L558-L573), [reference 21](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-turn.ts#L935-L958), [reference 22](https://a2ui.org/), [reference 23](https://a2ui.org/reference/renderers/), [reference 24](https://a2ui.org/ecosystem/renderers/), [reference 25](https://json-render.dev/docs), [reference 26](https://json-render.dev/docs/renderers), [reference 27](https://json-render.dev/docs/changelog), [reference 28](https://docs.ag-ui.com/concepts/generative-ui-specs), [reference 29](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces), [reference 30](https://ai-sdk.dev/docs/ai-sdk-rsc/overview), [reference 31](https://json-render.dev/docs/a2ui), [reference 32](https://json-render.dev/docs/ag-ui)

### FS-06: Fresh goal work chats are missing from ordinary chat lists

**Current status:** Partial; source changes and focused checks.

**Observed condition:** FS-06: Fresh goal work chats are missing from ordinary chat lists (medium severity, high confidence, new)

**Required improvement:** use a shared conversation serializer enforcing all query projections on every creation path, and backfill existing missing fields. Test goal create, startWork and tool creation followed by list/count; include ordinary chat/email/notification and imported writers in the same contract.

**Acceptance to establish:** Create work chats through goal, tool and suggestion paths, then list/count them through the normal application query. Required archived/purpose/trust fields match all supported writers and imports.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/goal-mutations.ts#L250-L263), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/firestore/src/goal-mutations.ts#L430-L479)

### HM19: Nested card validation discards its own sanitized result

**Current status:** Partial; source changes and focused checks.

**Observed condition:** renderableBlock rebuilds a section with invalid children removed (generative-card.ts 559–566). validateGroundedCard then returns the original card whenever only the top-level block count and action count are unchanged (448–454). A section with one valid metric and one invalid countdown has the same outer count, so the invalid countdown is restored. The source comment that malformed visual blocks are removed is therefore false for mixed nested sections.

**Required improvement:** always return the sanitized blocks/actions or track structural change recursively; validate that all surviving actions reference present/reveal-appropriate renderable facts. Keep this separate from semantic truth and sensitivity validation.

**Acceptance to establish:** one section containing valid metric plus invalid unzoned countdown, nonnumeric chart or malformed progress; nested section with no valid children; assert only the valid subtree survives and no original invalid child reappears.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/generative-card.ts#L448-L454), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/generative-card.ts#L559-L566), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/generative-card.ts#L719-L776)

### IOS-02: Push registration dedupe has no server or owner scope

**Current status:** Partial; source changes and focused checks.

**Observed condition:** After pairing assistant A and uploading APNs token T, the owner pairs B using the same installation. iOS returns T again; the global dedupe suppresses B registration. B loses pushes, while A still knows the device token. Old-server revocation and delivery effects need a server integration test; no particular old notification leak is asserted.

**Required improvement:** Scope registered token to authenticated server+owner+APNs environment and invalidate on pairing changes; revoke old server subscription when feasible.

**Acceptance to establish:** Pair A, upload token T, pair B with T unchanged, assert registration B and no A alerts routed to B.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/System/NotificationManager.swift#L94-L109), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L750-L801), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2803-L2821), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L1298-L1318), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2735-L2746), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2636-L2661), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2832-L2843), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2896-L2919), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2949-L2966), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/System/NotificationManager.swift#L216-L235), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L403-L429), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L678-L703)

### IOS-04: Notification inline decisions skip notification-owner check

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Tap Approve on an older assistant notification after changing pairing. Navigation would reject a foreign agentId, but the action branch never constructs or validates the destination and POSTs the approval ID to the current server. Typically this fails with 404; a cloned/reused ID can target a different approval. This finding is a missing client identity fence, not a demonstrated server authorization bypass.

**Required improvement:** Resolve notification identity against authenticated server/owner, rehydrate approval and review scope before action; otherwise open inbox.

**Acceptance to establish:** Old agent notification while paired to B cannot POST B; absent owner IDs require safe migration behavior.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/System/NotificationManager.swift#L216-L235), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L403-L429), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2803-L2821), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L1298-L1318), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2735-L2746), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2636-L2661), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2832-L2843), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2896-L2919), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L2949-L2966), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/System/NotificationManager.swift#L94-L109), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L750-L801), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/AppModel.swift#L678-L703)

### IOS-05: Late speech cancellation can clear replacement speech

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Speak A, immediately replace it with B. A delayed didCancel enqueues a main-actor drain callback after B has been queued. That callback clears B’s speakingMessageID and deactivates the session. In Talk mode, a nil speaking ID can advance listening early. This is a callback-order race inferred from source, not a measured playback failure.

**Required improvement:** Tag utterances/queues with generation and ignore old cancellation/drain callbacks; verify actual empty synthesizer queue before clearing.

**Acceptance to establish:** A speaking, speak B immediately, deliver delayed A didCancel; B remains marked active and audio session stays active.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/System/SpeechPlayer.swift#L34-L48), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/System/SpeechPlayer.swift#L82-L100), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/System/SpeechPlayer.swift#L344-L362)

### IOS-12: Generated map refresh keys ignore changed place values

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A refreshed saved card corrects a destination while preserving fact IDs. SwiftUI keeps the same task ID and Pin state, so the displayed pin can remain at the old destination while its text and Maps action use the corrected value. Late geocode results are also not generation-fenced in resolve().

**Required improvement:** Key by stable card revision plus fact ID/value or coordinate; discard old geocode completion and bound/cancel lookups.

**Acceptance to establish:** Refresh a card retaining place IDs but changing address or coordinates; pin and Maps action agree and stale old resolution cannot overwrite new result.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/GeneratedCardBlocks.swift#L528-L575), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/GeneratedCardBlocks.swift#L250-L275), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/GeneratedCardBlocks.swift#L327-L337)

### IOS-15: Talk ignores failure to enable echo cancellation

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Voice-processing I/O refuses enablement, but try? discards the error and the always-open Talk loop proceeds. Assistant playback may then be transcribed as user speech, triggering barge-in/auto-submit. It is a fail-open assumption that requires injected-error and physical audio-route testing, not proof this happens on every phone.

**Required improvement:** Fail closed into explicit half-duplex mode if echo cancellation cannot be verified; surface state and suppress assistant-audio transcription with audio session arbitration.

**Acceptance to establish:** Inject voice-processing setup failure and speaker playback; no self-triggered send or false barge-in.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/System/SpeechListener.swift#L177-L207), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/TalkView.swift#L233-L266), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/System/SpeechListener.swift#L119-L175), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/System/SpeechListener.swift#L177-L227), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/TalkView.swift#L147-L151)

### IOS-16: Scoreboard logo allowlist accepts lookalike external hosts

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A score payload contains a logo URL such as The regex accepts it because there is no hostname-label boundary before espncdn.com, and rendering triggers an automatic image request to that unrelated host. This defeats the documented CDN-only invariant. Upstream payload trust affects exploitability; no external URL was visited.

**Required improvement:** Parse URLComponents; require exact espncdn.com or host suffix .espncdn.com with an actual label boundary, and reject unapproved URL credentials/ports/redirect destinations.

**Acceptance to establish:** Reject attackerespncdn.com, espncdn.com.attacker.test and userinfo confusion; accept explicitly permitted real CDN subdomains. No hostile URL was fetched.

Source references: [reference 1](https://attackerespncdn.com/logo.png), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/ScoreboardCardView.swift#L49-L66), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/ScoreboardCardView.swift#L225-L238), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/ScoreboardCardView.swift#L69-L74), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/ScoreboardCardView.swift#L134-L182)

### IOS-17: Future scoreboards have no clock-driven transition into live polling

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Leave a future scoreboard visible from more than ten minutes before the game begins. The initial polling condition is false and its task exits. The passage of wall time alone does not publish a SwiftUI state change, so live polling depends on unrelated redraws rather than the promised eligibility window. This is a missing time trigger, not a claim that every normal session stays stale.

**Required improvement:** Schedule a bounded wake for next eligibility time or feed an explicit minute clock only while visible; use revision-aware local game state and last-success freshness.

**Acceptance to establish:** Open >10 minutes before kickoff and advance clock without other model updates; polling begins at threshold, stays offscreen/background-safe, and stops at final.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/ScoreboardCardView.swift#L69-L74), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/ScoreboardCardView.swift#L134-L182), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/ScoreboardCardView.swift#L49-L66), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/ScoreboardCardView.swift#L225-L238)

### IOS-18: Unbounded card numbers reach trapping integer conversions

**Current status:** Partial; source changes and focused checks.

**Observed condition:** JSONValue decodes numbers as Double. Its shared integerValue accessor tests integrality but not representability before Int(numberValue). A finite JSON number such as 1e30 is integral yet outside Int range. This traps rather than returning nil. Direct conversions also exist for numeric sheet cells, scoreboard pollSeconds, weather readings, document similarity and graph confidence. A malformed durable card can therefore terminate rendering repeatedly when its conversation is opened; no crash was executed in this review. This is an input-validation defect, not a claim the current ordinary server always produces such values.

**Required improvement:** Use nontrapping exact conversions and domain-specific numeric bounds at card decoding; preserve large spreadsheet numbers as formatted numeric text. Reject or degrade an individual invalid card rather than its entire message. Bounds must apply before derived multiplication/rounding as well as at the original field.

**Acceptance to establish:** Decode and render integer-valued 1e30 and negative out-of-range numbers at every numeric leaf; exercise Double(Int.max) rounding boundaries, huge finite weather/confidence values, fractional version/poll values, and malformed persisted cards. Verify readable fallback and continued conversation access.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Models/APIModels.swift#L89-L105), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L4798-L4806), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1464-L1484), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1528-L1543), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L2702-L2714), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3765-L3773), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1617-L1624), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3593-L3596), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1336-L1344), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3511-L3513), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3227-L3245), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3305-L3313), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1436-L1443), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1549-L1560), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3660-L3675), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3750-L3762)

### IOS-19: Duplicate knowledge-card node IDs trap during parsing

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A knowledge-graph data card with two node records sharing an id reaches Dictionary(uniqueKeysWithValues:) without deduplication. Swift requires unique keys and traps when this precondition is violated, before the card can fall back. The same file already uses a duplicate-tolerant dictionary for generated facts, so safety differs by card kind.

**Required improvement:** Validate IDs as part of the card schema and choose an explicit duplicate policy, rejecting the card or retaining a deterministic record with a visible integrity warning. Do not use trapping dictionary initializers at a network-content boundary.

**Acceptance to establish:** Duplicate graph IDs with equal and conflicting labels; missing/empty IDs; repeated persisted-card delivery. The message should remain renderable with a safe result, never terminate the app.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1336-L1344), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3511-L3513), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3765-L3773), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1617-L1624), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3593-L3596), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L4798-L4806), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1464-L1484), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1528-L1543), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L2702-L2714), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3227-L3245), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3305-L3313), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1436-L1443), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1549-L1560), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3660-L3675), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3750-L3762)

### IOS-20: Partial availability can be presented as unqualified “Free”

**Current status:** Partial; source changes and focused checks.

**Observed condition:** An availability card contains no busy blocks but complete=false, for example because calendars could not all be checked. The headline still says “Free” and the body “Nothing on the calendar in this window.” Only a small coverage footer can qualify this; if calendarsChecked is empty and note absent, complete=false produces no warning at all. A user relying on the headline can arrange a conflicting meeting despite the response explicitly reporting incomplete evidence.

**Required improvement:** Make coverage part of the primary availability state. Only complete evidence may say free; partial/unknown evidence should say no conflicts found in checked calendars, or availability unconfirmed when none were checked. Decide an explicit compatibility policy for missing completeness rather than assuming a verified result.

**Acceptance to establish:** Empty busy array with complete=false and zero/one/multiple checked calendars, absent notes, malformed discarded busy blocks and older payloads missing completeness. Visible and spoken summaries must preserve uncertainty.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3227-L3245), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3305-L3313), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1436-L1443), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3765-L3773), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1617-L1624), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3593-L3596), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L4798-L4806), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1464-L1484), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1528-L1543), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L2702-L2714), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1336-L1344), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3511-L3513), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L1549-L1560), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3660-L3675), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Components/MessageBubble.swift#L3750-L3762)

### IOS-22: Graph VoiceOver reverses directed relationships at the object endpoint

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The canvas stores one relationship label per unordered link, then builds a node’s accessibility summary as label plus the other node’s name, regardless of whether this node is the recorded subject or object. For a parent→child relationship, focusing the child can announce the parent-direction phrase against the parent. The drawing uses edgeDirections for arrowheads correctly, so visible direction and spoken meaning diverge. The People branch view has its own inverse-role logic, but the canvas does not use it. This is an accessibility factual-direction error, not a failure of the graph’s bidirectional topology.

**Required improvement:** Supply typed subject/object/predicate with forward and inverse descriptions, or speak the complete authoritative sentence with both endpoints rather than reconstructing it. Preserve unknown inverse forms as complete recorded sentences; do not infer gender from an inverse.

**Acceptance to establish:** Inspect accessible values at both ends of parent_of, child_of, works_at and symmetric sibling/spouse relations. Both ends must describe the same fact with correct direction and provenance/review state.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/RelationshipGraphCanvas.swift#L294-L300), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/RelationshipGraphCanvas.swift#L1215-L1226), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/RelationshipGraphCanvas.swift#L1426-L1455), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/RelationshipGraphScreen.swift#L831-L849), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/KnowledgeView.swift#L350-L369), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/KnowledgeView.swift#L467-L550), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/KnowledgeView.swift#L575-L603)

### IOS-23: Import size limits are enforced only after a full synchronous file read

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Select an oversized document, backstory file or writing-sample file. Each UI Task first runs Data(contentsOf:) synchronously for the complete selected URL, then checks its data.count against 25 MB. The intended cap therefore cannot bound read time or allocation, and a local or cloud-backed large file can block the UI or exhaust memory before the friendly rejection appears. The broad document picker accepts any item and writing/backstory pickers also include .data. No large file was imported or device symptom reproduced.

**Required improvement:** Check available file-size metadata before allocation and perform a bounded, cancellable background read that aborts at limit+1 bytes even if metadata is missing or changes. Keep security-scoped access alive only for the bounded operation and publish progress/errors on the main actor.

**Acceptance to establish:** Oversized local/cloud-provider files, unavailable size, changing size, delayed provider reads and dismissal/cancellation; peak allocation stays bounded and no upload begins for a rejected file.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/WorkspaceView.swift#L1806-L1849), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/MemoryView.swift#L787-L806), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/WorkspaceView.swift#L160-L180)

### IOS-24: Knowledge item save can merge after rename/retype failed

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Edit a graph item’s name/type and choose a merge target. save() awaits rename, then retype, then merge even if an earlier operation returned false. If rename fails but merge succeeds, the original record can be removed into the target while the form remains open because the final success check requires all three results. The owner sees an unsuccessful edit against a now-retired ID and retry is no longer a retry of the same compound change. The fields/merge target also remain editable during awaits, so later stages need not use the values initially submitted. No destructive operation was executed in this review.

**Required improvement:** Submit one atomic, versioned edit/merge command using captured immutable inputs. For a transitional multi-call API, stop on failure, report exactly what changed, disable editing/dismissal during the request, and reconcile surviving identity before allowing retry.

**Acceptance to establish:** Inject rename failure/retype success/merge success, retype failure, lost response after merge, and field/target changes while the first request waits. No later destructive stage follows a failed prerequisite, and partial completion is reported truthfully.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/KnowledgeView.swift#L467-L550), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/KnowledgeView.swift#L575-L603), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/KnowledgeView.swift#L350-L369)

### WEB-01: Local mobile-key rotation weakens .env file permissions

**Current status:** Partial; source changes and focused checks.

**Observed condition:** settings/actions.ts:216–227 writes an entirely new temp file using writeFileSync without a mode and renames it over .env; 272–296 is the reachable token-rotation action. The operations reviewer confirmed scripts/setup.ts:60 deliberately creates .env with 0o600. With umask 022, the new file becomes 0644. Its contents include all .env secrets, not only the rotated mobile key. A backup also retains prior values; gitignore is not a filesystem privacy boundary. The Secret Manager path is not affected by the local permission change.

**Required improvement:** explicitly create secret temp files with restrictive permissions, preserve or tighten the existing mode, protect backup permissions/lifetime, and serialize competing configuration writers. Regression: rotate a synthetic 0600 .env under umask022 and assert final and backup modes, secret persistence, and crash-safe content. Run only in an authorized disposable fixture.

**Acceptance to establish:** rotate a synthetic 0600 .env under umask022 and assert final and backup modes, secret persistence, and crash-safe content. Run only in an authorized disposable fixture.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/settings/actions.ts#L216-L227), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/settings/actions.ts#L272-L296), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/scripts/setup.ts#L60)

### WEB-02: Administration lost a discoverable per-browser sign-out

**Current status:** Implemented and locally verified.

**Observed condition:** owner pairs a phone from a shared browser and wants to end only that session. Fix: always-visible owner account menu with “Sign out of this browser,” distinct from revoke-everywhere. Regression: test Google/passkey modes through actual routing and verify the session is unusable after logout and Back navigation does not re-expose secret UI.

**Required improvement:** always-visible owner account menu with “Sign out of this browser,” distinct from revoke-everywhere. Regression: test Google/passkey modes through actual routing and verify the session is unusable after logout and Back navigation does not re-expose secret UI.

**Acceptance to establish:** test Google/passkey modes through actual routing and verify the session is unusable after logout and Back navigation does not re-expose secret UI.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/admin-navigation.tsx#L10-L14), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/layout.tsx#L60-L69), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/settings/page.tsx#L28-L56), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/actions.ts#L7-L14), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/security/security-client.tsx#L479-L501)

### WEB-03: Retained provider form carries a credential across provider destinations

**Current status:** Partial; source changes and focused checks.

**Observed condition:** settings/ai-providers.tsx:543–565 maintains one apiKey state for all providers, while 578–581 changes only kind. A user entering an OpenAI/OpenRouter key and then changing to a custom compatible server can submit that same key to the new destination; provider-actions.ts:34–38 saves and tests it. Provider transport behavior is covered by the models review, so this report does not assert an external exfiltration already occurred.

**Required improvement:** scope secret input state to provider identity and endpoint, clear on destination change, explicitly show the destination before connection, and avoid persisting/testing hidden credentials. Regression: enter key, switch through all provider kinds, change endpoint, verify outgoing data uses only a credential entered for that exact destination.

**Acceptance to establish:** enter key, switch through all provider kinds, change endpoint, verify outgoing data uses only a credential entered for that exact destination.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/settings/ai-providers.tsx#L543-L565), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/settings/ai-providers.tsx#L578-L581), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/settings/provider-actions.ts#L34-L38)

### WEB-04: Retained KG date correction submits the old date identity

**Current status:** Partial; source changes and focused checks.

**Observed condition:** profile/knowledge/add-relation.tsx:144 retains the correction's picked date entity, 204–209 submits that ID but renders a fresh uncontrolled DateValueInput, and 42–110 never clears the selected ID or updates the sentence preview. Shared packages/core/src/memory/knowledge-graph.ts:1180–1202 resolves existing endpoints by ID, ignoring newly typed labels. A changed date therefore remains the old identity, causing duplicate-source rejection or an old-date replacement rather than the requested correction.

**Required improvement:** controlled date endpoint with canonical prefill, clear/change endpoint identity on date edits, update the preview from actual submitted values, and test the browser-generated FormData. Current integration tests manually construct FormData and miss this bug (knowledge.firestore.test.ts:544–556). Include day, month, recurring date, untouched correction, and changed-date correction.

**Acceptance to establish:** In the dormant editor, change a graph date identity, submit, reload and ingest later evidence. The mutation sends the edited identity and displays the authoritative saved result without reusing the old value.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/profile/knowledge/add-relation.tsx#L144), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/profile/knowledge/add-relation.tsx#L204-L209), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/profile/knowledge/add-relation.tsx#L42-L110), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/knowledge-graph.ts#L1180-L1202), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/profile/knowledge/add-relation.tsx#L458-L466)

### WEB-05: Retained editors let “Cancel” dismiss an already-submitted mutation

**Current status:** Partial; source changes and focused checks.

**Observed condition:** profile/knowledge/add-relation.tsx:376–377,458–466 disables Save during the action but permits Cancel and modal dismissal. The server action proceeds independently. Entity editor Done similarly closes during rename/retype/merge (entity-forms.tsx:315–335). The outcome can be a saved/merged fact after an apparent cancellation, with its result hidden. This should not be silently imported into the native UI.

**Required improvement:** distinguish pre-submit Cancel from post-submit Close; disable destructive-dismissal or explicitly state the save continues; retain a durable result receipt outside the dialog. Add deferred-response tests for close, Escape, backdrop, navigation, repeated Save and late errors. Related dormant AgentForm/NotificationForm inputs remain editable while saving and can show “Saved” beside newer unsaved values; snapshot/version-bind the save receipt.

**Acceptance to establish:** Submit a retained editor mutation, delay the response and tap Cancel or navigate. Cancellation copy never implies an already-submitted effect was undone; drafts/state reconcile to the actual outcome.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/profile/knowledge/add-relation.tsx#L458-L466), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/profile/knowledge/add-relation.tsx#L144), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/profile/knowledge/add-relation.tsx#L204-L209), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/profile/knowledge/add-relation.tsx#L42-L110)

### WEB-06: Retained live-call controls can hide a second question

**Current status:** Partial; source changes and focused checks.

**Observed condition:** [calls/[id]/live-controls.tsx:17–40]( sets one sent flag after the first check-in answer. It is never reset for a new checkin.id; the parent renders the same unkeyed component (calls/[id]/page.tsx:52–63). A later question on the same call stays hidden behind “Sent.” The generic AutoRefresh also backs off to 120 seconds (auto-refresh.tsx:19,39–45), exceeding the roughly one-minute check-in response window described by this UI. A pending answer request disables Hang up as well.

**Required improvement:** key/reset answer state by call and check-in identity, retain receipts per check-in, poll or stream live calls at a bounded latency appropriate to their deadline, and make emergency hang-up independently available. Regression: answer A, deliver B without remount, delayed answer response, expired check-in, hidden/visible tab, network hang, and hang-up while answer save is pending. The call transcript's “Nothing was said” when no transcript rows exist (page.tsx:94–99) should become “No transcript available”; missing capture is not proof of silence.

**Acceptance to establish:** answer A, deliver B without remount, delayed answer response, expired check-in, hidden/visible tab, network hang, and hang-up while answer save is pending. The call transcript's “Nothing was said” when no transcript rows exist (page.tsx:94–99) should become “No transcript available”; missing capture is not proof of silence.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/calls/%5Bid%5D/live-controls.tsx#L17-L40)

### WEB-07: Revealed sensitive values remain inaccessible through the control's accessible name

**Current status:** Partial; source changes and focused checks.

**Observed condition:** [chat/[id]/sensitive-value.tsx:40–50]( replaces the button's accessible name with “Show/Hide [label]” in both states. The actual value appears only as its child text when revealed, so it is still overridden by aria-label. A screen-reader user can activate reveal without receiving the booking/reference value.

**Required improvement:** separate the toggle name from the revealed text, associate the latter as an accessible description/live result only while revealed, and keep concealed values out of all accessible names and descriptions. Regression: real accessibility-tree/VoiceOver inspection for masked, revealed, hidden again and rerendered states; test keyboard and copy affordance without exposing concealed content.

**Acceptance to establish:** real accessibility-tree/VoiceOver inspection for masked, revealed, hidden again and rerendered states; test keyboard and copy affordance without exposing concealed content.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/sensitive-value.tsx#L40-L50)

### WEB-08: Dormant cap form rejects values accepted and persisted by the API

**Current status:** Partial; source changes and focused checks.

**Observed condition:** costs/page.tsx:142–173 requires daily increments of $0.50 and monthly increments of $1.00. Its integration test stores a valid daily limit of $2.75 (costs/page.test.tsx:124–138). Loading that value into a number input with min0.5/step0.5 makes an untouched field invalid, preventing ordinary submission when the owner changes a different cap. The UI also silently submits blanks/invalid values to a void wrapper; blanks keep previous values, they do not remove caps.

**Required improvement:** align all numeric constraints to the shared budget schema, validate the entire change atomically, and show per-field errors plus explicit “leave unchanged”/“remove cap” semantics if removal is supported. Regression: existing non-step values, decimals, tiny positive values, empty strings, numeric prefixes and simultaneous cap edits. The underlying partial-write/numeric-validation issue is already in the application/API report; this is the client-contract consequence, not an additional duplicate backend finding.

**Acceptance to establish:** existing non-step values, decimals, tiny positive values, empty strings, numeric prefixes and simultaneous cap edits. The underlying partial-write/numeric-validation issue is already in the application/API report; this is the client-contract consequence, not an additional duplicate backend finding.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/costs/page.tsx#L142-L173)

### WEB-09: Uncontrolled action forms can erase a failed submission

**Current status:** Partial; source changes and focused checks.

**Observed condition:** profile/add-fact.tsx:48–75, people/add-person.tsx:26–65, and people/occasions-panel.tsx:267–371 use uncontrolled inputs and a React function action whose wrapper returns startTransition(...) (void). No submitted-value echo or controlled draft preserves the fields when an action returns an ordinary {error} result. Unlike GoalForm's echoed values or SkillForm's controlled draft, the user's edit can reset to defaults while an error is shown. The occasions editor also allows another edit/cancel while a save is pending, and one shared busyId does not track multiple concurrent row requests.

**Required improvement:** reusable controlled form/draft state, awaited actions with explicit result types, action-session generation fences, and preserve input on expected validation and transport failure. Regression: invalid occasion date, duplicate fact/person, delayed failures, edit another row while first request is pending, and cancellation before versus after commit. This is part of WEB-05's broader lifecycle fix; do not count the same affected control twice in master totals.

**Acceptance to establish:** invalid occasion date, duplicate fact/person, delayed failures, edit another row while first request is pending, and cancellation before versus after commit. This is part of WEB-05's broader lifecycle fix; do not count the same affected control twice in master totals.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/profile/add-fact.tsx#L48-L75), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/people/add-person.tsx#L26-L65), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/people/occasions-panel.tsx#L267-L371)

### WEB-10: Retained scoreboards do not schedule their own future activation

**Current status:** Partial; source changes and focused checks.

**Observed condition:** chat/[id]/scoreboard-card.tsx:75–85,183–224 evaluates the ten-minute pregame threshold using Date.now during render and starts an interval only while that computed live value is true. A visible card first mounted more than ten minutes before kickoff has no wake timer to reevaluate the threshold, so it can remain frozen unless another state/parent update rerenders it. Its game state is also initialized from props once, without reconciling later server card data. Fetch failures preserve a live-looking label and old values rather than showing stale/offline state.

**Required improvement:** schedule the next eligibility boundary, refresh on visibility restoration, reconcile revision-qualified server snapshots, and expose last-success/staleness/error status. Regression: frozen clock crossing kickoff without parent renders, new server card revision, failed polling, tab hide/show, final state, unmount, and out-of-order responses.

**Acceptance to establish:** frozen clock crossing kickoff without parent renders, new server card revision, failed polling, tab hide/show, final state, unmount, and out-of-order responses.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/[id]/scoreboard-card.tsx#L75-L224)

### WEB-11: A settled task stops the retained thread's lifetime poll

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The hook describes one poll for the entire open thread, but use-chat-polling.ts:445–458 returns settle(...) when a task is done with an assistant row, parked with its decision/grace satisfied, failed, or cancelled. settle at 342–348 updates React state and clears the task; it neither polls nor schedules. The normal scheduling at 479 is skipped. The tick wrapper schedules only an already-queued wake (495–501), and ChatClient's effect pokes only a non-null async turn (351–353). Therefore a normal terminal response with no queued wake leaves no next poll. Later watch/mail replies or post-approval task output can remain unseen while the tab stays foregrounded, until another turn, refresh event, visibility change, or effect restart wakes it. The five-minute timeout branch explicitly reschedules and does not have this particular defect.

**Required improvement:** make each iteration have one explicit lifetime reschedule path independent of the task-presence state; stop only for unmount or a deliberately terminal authentication condition. Keep long-poll serialization, cursor replay and unchanged-message identity. Regression: mount the actual hook, deliver done/failed/cancelled and each parked state, then append an unrelated durable message and a resumed approval result without a visibility/new-turn wake. Assert updates continue and requests remain serialized. Current use-chat-polling.test.ts exercises only pure helpers, not this lifecycle.

**Acceptance to establish:** mount the actual hook, deliver done/failed/cancelled and each parked state, then append an unrelated durable message and a resumed approval result without a visibility/new-turn wake. Assert updates continue and requests remain serialized. Current use-chat-polling.test.ts exercises only pure helpers, not this lifecycle.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/use-chat-polling.ts#L445-L458)

### WEB-12: Text-only reconciliation removes legitimately repeated provisional turns

**Current status:** Partial; source changes and focused checks.

**Observed condition:** message-view.tsx:137–151,180–194 builds a fresh multiset of the entire durable transcript's trimmed text on every reconciliation, then removes matching provisional user/reply entries. It does not bind a match to the originating operation, timestamp, task, or already-consumed durable twin. An old durable “status?” can retire today's new optimistic “status?” before today's send has persisted. The existing one-durable/two-local test only calls the helper once: calling it on the resulting log again removes the second local question against the same durable row. Identical repeated assistant replies and empty-text card-only replies have the same identity problem. This is local display/reconciliation loss, not a claim that the server deletes durable history.

**Required improvement:** carry stable client operation/message identity through acceptance and persistence and reconcile only its acknowledged twin; retain unmatched provisional messages with explicit pending/failed state. Regression: two genuine identical requests separated by durable history, repeated idle merges of the same inputs, send failure before persistence, repeated identical replies from different tasks, and card-only messages with different payloads. Preserve the useful timestamp/arrival ordering and contract-replacement matching tests while removing text as the identity contract.

**Acceptance to establish:** two genuine identical requests separated by durable history, repeated idle merges of the same inputs, send failure before persistence, repeated identical replies from different tasks, and card-only messages with different payloads. Preserve the useful timestamp/arrival ordering and contract-replacement matching tests while removing text as the identity contract.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/message-view.tsx#L137-L194)

### WEB-13: Generated-card “ask” actions bypass the chat's busy exclusion

**Current status:** Partial; source changes and focused checks.

**Observed condition:** chat-log.tsx:301–307 passes onSend to ResponseCards without busy state. GeneratedCard's ask button remains enabled and invokes it at response-card.tsx:1696–1706. ChatClient's stable handler calls sendTurn directly (chat-client.tsx:743–755,784), which has no busy check or synchronous admission mutex; the guard exists only in the composer submit and run-for-real entry points. A saved card can therefore invoke another SDK send during an active stream/executor task, contradicting ChatMessageRow's contract that nothing in the log can start another turn while busy. Exact SDK/server handling of overlapping sends is not executed here; multiple callback invocations are source-established.

**Required improvement:** centralize turn admission, one-shot autonomy/force flags and operation identity in one guarded entry point; pass disabled/pending semantics to every generated action. Decide explicitly whether owner follow-ups queue, steer, or supersede active work rather than accidentally doing any of them. Regression: tap generated asks during submitted, streaming, async execution, cancellation, and rapid double-click; assert one intended accepted operation and correct draft/autonomy scope. This aligns with the master conversational-control work, not an independent permission bypass claim.

**Acceptance to establish:** tap generated asks during submitted, streaming, async execution, cancellation, and rapid double-click; assert one intended accepted operation and correct draft/autonomy scope. This aligns with the master conversational-control work, not an independent permission bypass claim.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/chat-log.tsx#L301-L307), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/response-card.tsx#L1696-L1706), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/response-card.tsx#L1897-L1906), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/response-card.tsx#L1064-L1092), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/response-card.tsx#L1575-L1586)

### WEB-14: Shallow card eligibility suppresses prose for unsupported v1 content

**Current status:** Partial; source changes and focused checks.

**Observed condition:** response-card.tsx:1897–1906 accepts every generated v1 card with a title and nonempty fact/block arrays. The renderer implements only hero, facts, timeline, score, code, note and image (1440–1589); unknown blocks return null. Current pinned generative-card.ts:21–102 legitimately includes richer leaf blocks and sections under version 1. A valid evidence-grounded card containing only a section or chart is declared renderable, while its entire answer body disappears and ChatLog suppresses its prose (chat-log.tsx:176–181). Unsupported native actions are also silently absent. Do not mistake an unchanged schema version for client capability parity.

**Required improvement:** a shared capability/required-field registry, recursive supported-block and referenced-fact checks, explicit native-only action fallback, and fallback-preserving partial rendering. Keep prose whenever any material part requires it; display unknown metrics as unknown. Regression: valid v1 sections and every current block kind, mixed supported/unsupported blocks, missing references, mixed accompanying/lookup cards, missing/null/string/negative route metrics and empty specialized payloads. Existing tests assert basic kind/version eligibility and static successful previews, not this compatibility matrix. Do not reopen web product routes to implement the shared contract.

**Acceptance to establish:** valid v1 sections and every current block kind, mixed supported/unsupported blocks, missing references, mixed accompanying/lookup cards, missing/null/string/negative route metrics and empty specialized payloads. Existing tests assert basic kind/version eligibility and static successful previews, not this compatibility matrix. Do not reopen web product routes to implement the shared contract.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/response-card.tsx#L1897-L1906), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/generative-card.ts#L21-L102), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/response-card.tsx#L1696-L1706), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/response-card.tsx#L1064-L1092), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/response-card.tsx#L1575-L1586)

### WEB-15: Incomplete calendar evidence is still described as free

**Current status:** Partial; source changes and focused checks.

**Observed condition:** response-card.tsx:1064–1092 says “Nothing on the calendar in this window” for an empty busy array and “the gaps are free” unconditionally, even when complete=false. Its trailing partial-coverage warning does not make either affirmative claim true. Unlike the native branch, this web component does render the caveat even when no calendar names are present; preserve that distinction. Multi-day busy rows also show clock ranges without dates, which can make identical times on different days ambiguous.

**Required improvement:** lead with incomplete/unknown coverage whenever completeness is false or cannot be established; reserve free for a fully checked window and show date-qualified intervals. Regression: empty/nonempty busy rows with complete false/true/absent, zero and multiple checked calendars, discarded malformed rows, missing warning note, and a multi-day window. Carry the same uncertainty to accessible and spoken summaries.

**Acceptance to establish:** empty/nonempty busy rows with complete false/true/absent, zero and multiple checked calendars, discarded malformed rows, missing warning note, and a multi-day window. Carry the same uncertainty to accessible and spoken summaries.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/response-card.tsx#L1064-L1092), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/response-card.tsx#L1696-L1706), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/response-card.tsx#L1897-L1906), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/response-card.tsx#L1575-L1586)

### WEB-16: Generated sensitive facts leak through secondary projections

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The ordinary generated leaves use shownValue to honor sensitive flags, but response-card.tsx:1575–1586 reads the raw URL and alt fact values for an image without checking either flag. Thus a masked fact reused as alt text becomes immediately accessible, and a sensitive URL is embedded in a render-time image request. The card's outer accessible label/title/subtitle are also projected verbatim (1594,1610–1614), so hiding its fact does not protect a duplicate in generated chrome. Core fact-reference/URL/layout validation does not remove these sensitive image references (generative-card.ts:427–454,499–501,559–592). This is not a claim that arbitrary URLs bypass the separate image proxy's network defenses.

**Required improvement:** enforce one privacy projection across visible text, accessible labels, image URLs/alt, links and clipboard actions; require explicit reveal/consent for a sensitive outward projection, sanitize duplicate sensitive strings from generated chrome, and reset reveal state when the underlying fact value/revision changes. Current reveal state is keyed only by fact ID (1349,1411–1435), so a refreshed value can inherit the previous value's reveal. Regression: the same sensitive fact in every supported field plus outer labels, delayed image load, refreshed fact retaining ID, and primary code reveal. Keep WEB-07's separate requirement that intentionally revealed content becomes accessible.

**Acceptance to establish:** the same sensitive fact in every supported field plus outer labels, delayed image load, refreshed fact retaining ID, and primary code reveal. Keep WEB-07's separate requirement that intentionally revealed content becomes accessible.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/response-card.tsx#L1575-L1586), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/response-card.tsx#L1696-L1706), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/response-card.tsx#L1897-L1906), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/%5Bid%5D/response-card.tsx#L1064-L1092)

### WEB-17: An old task poll can clear a newer task's state

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The poll captures asyncTurnRef.current before awaiting fetch (use-chat-polling.ts:350–366,401–404), then updates activity and calls unqualified settle from that response (423,440–458). settle clears the shared async turn at 345 without checking its task ID. In the same mounted chat, cancel A while its poll is outstanding, let cancellation free the composer (chat-client.tsx:809–818), then send B and receive B's handoff (283–285). A's late done/cancelled/failed response can now clear B and its activity. Queuing poll wakes serializes requests, but it does not fence response ownership. Cleanup likewise sets cancelled without aborting the fetch or guarding post-await message/cursor publication (534–540); conversation reuse/remount behavior needs the proposed mounted integration test before claiming a particular cross-conversation leak.

**Required improvement:** task/request/conversation generation fences after every await; settle only the captured task if it is still current; cancel in-flight observation on cleanup; keep known older tasks in a separate durable tracking state. Regression: delayed A poll, acknowledged A cancellation, accepted B handoff, then A response; B's state and controls must survive. Cover cancellation completion after a newer task too, unmount/remount and StrictMode effect replay. The generic “Stopped by you” receipt also inherits API-06's already-terminal/no-op ambiguity and should be corrected with that shared server contract, not counted again as a new backend defect.

**Acceptance to establish:** delayed A poll, acknowledged A cancellation, accepted B handoff, then A response; B's state and controls must survive. Cover cancellation completion after a newer task too, unmount/remount and StrictMode effect replay. The generic “Stopped by you” receipt also inherits API-06's already-terminal/no-op ambiguity and should be corrected with that shared server contract, not counted again as a new backend defect.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/chat/[id]/use-chat-polling.ts#L350-L458)

### VH-02: Call ledger omits charge components and does not reconcile the complete bill

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The call flow enables Twilio Media Streams and AMD, and OpenAI input transcription, while settlement mainly applies a single carrier-minute rate plus Realtime response usage. Published rates do not establish the actual account invoice.

**Required improvement:** Separate carrier/media/AMD/transcription/audio/text/cache/reasoning/backend/runtime amounts and basis. Persist late usage and asynchronously reconcile provider prices; label incomplete estimates and unknown charges truthfully.

**Acceptance to establish:** Exercise spoken/listening/hold/disclosure/reconnect ratios, separate transcription usage, cached modality fields and delayed carrier price. Attribute each component once, keep missing charges pending and compare total cost per successful call.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/twilio/voice.ts#L70-L148), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/realtime-voice/openai.ts#L177-L208), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/realtime-voice/voice-model.ts#L112-L129), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/calls/finish.ts#L41-L112), [reference 5](https://www.twilio.com/en-us/voice/pricing/us), [reference 6](https://developers.openai.com/api/docs/guides/voice-latency-cost)

### API-07: Budget edits silently succeed on rejected input and use permissive numeric parsing

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A client sending numbers instead of form strings, zero to stop spending, an excessive amount or invalid text can see success although its intended cap did not change. Numeric-prefix junk such as 12garbage is accepted as 12. A positive amount below half a cent can become 0.00 after the pre-round positivity check. A later PostgreSQL write failure can leave an earlier scope updated, unlike the atomic Firestore test.

**Required improvement:** Define an explicit decimal/micro-unit contract, reject supplied invalid fields, report applied values, and make multi-scope changes atomic. Define deliberately whether zero is a hard stop and whether null means unlimited; do not infer either from blank text. Preserve omitted-field-as-unchanged PATCH behavior.

**Acceptance to establish:** Numeric vs string input, prefixes, whitespace, zero, sub-cent values, upper bounds, partially supplied body, completely invalid body and a failure on the second scope. Confirm actual persisted caps in the receipt.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/costs/route.ts#L12-L40), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/costs.ts#L137-L164), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/costs/route.test.ts#L107-L117)

### APP-08: Text-model selection can retain a non-text fallback

**Current status:** Partial; source changes and focused checks.

**Observed condition:** existing role fallback points at an embedding/live-voice catalog entry (migration, direct role configuration, or model-capability edit). Choosing valid text primaries retains it; primary outage routes to an unusable model. A missing provider connection is similarly not excluded by connectionOff, which only detects explicit disabled rows.

**Required improvement:** central request-profile compatibility validation shared by primary, fallback, overrides, role assignments and catalog edits; validate provider availability and persisted embedding-space constraints atomically. Regression: text main with live/embedding fallback, capability edit of an in-use model, removed connection, and primary failure; do not mark settings successful with an invalid failover route.

**Acceptance to establish:** text main with live/embedding fallback, capability edit of an in-use model, removed connection, and primary failure; do not mark settings successful with an invalid failover route.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/model-providers.ts#L560-L657)

### AUX-MODELS-COST: Timeout/abort usage and metering failures need conservative durable reconciliation

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A provider may bill an aborted/timed-out/error attempt, or successful usage metering may fail. Releasing its hold is not evidence that the attempt was free.

**Required improvement:** Persist attempt identity and unknown-usage liabilities; reconcile late actuals independently of task terminal state and budget holds.

**Acceptance to establish:** Inject paid timeout, lost usage write and late provider actuals after hold expiry. Every attempt remains attributable exactly once; missing amounts remain pending/unknown rather than zero.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts)

### AUX-VOICE-CONTRACT: Realtime session readiness, tool-follow-up and cost estimation need provider contract qualification

**Current status:** Open.

**Observed condition:** Realtime WebSocket open is not session-configuration acceptance; Gemini tool follow-up semantics and hung connection paths differ from the shared interface.

**Required improvement:** Negotiate explicit provider readiness, classify terminal/configuration/transport errors and implement or explicitly reject unsupported follow-up behavior.

**Acceptance to establish:** Reject session config after socket open, hang connect/resume, and exercise none/if_silent with both adapters. No false-ready call or unbounded wait; no duplicated action on reconnect.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/sports/espn.ts#L93-L102), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/sports/lookup.ts#L139-L188), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/maps/apple.ts#L97-L105), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/realtime-voice/openai.ts#L110-L133), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/realtime-voice/gemini.ts#L259-L275), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/audit-capture.ts#L26-L65), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/audit-graders.ts#L369-L389), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/calendar-module.ts#L11-L23), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/application-confirmations.ts#L530-L570)

### COST-03: P1. Separate budget fallback from capability fallback

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Choose the cheapest compatible, quality-approved route for budget pressure using current request shape and conservative effective prices. Maintain a distinct reliability alternative for outages. Do not downgrade below a role's quality floor; park honestly when none fits. Budget decision, reasoning and reservations.

**Required improvement:** Separate budget fallback from reliability fallback and require the cheaper route to satisfy the exact request profile, privacy requirements and total remaining-operation budget.

**Acceptance to establish:** Under budget pressure, compare candidate fallback cost for the exact prepared request and remaining stages. An incompatible or more expensive route is not silently selected as the cheap fallback.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/budget.ts), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L760-L894), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L687-L753), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1577-L1625), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L899-L917), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L537-L553), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L919-L1005), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1361-L1410), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L475-L512)

### COST-04: P1. Put actual price constraints around latency selection

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Production classify/draft routing sorts OpenRouter providers by latency. The adapter supports max_price, but runtime construction does not supply it; the isolated evaluator does. The source comment that latency ordering costs nothing is not generally true across the displayed providers. Add per-role/request ceilings and capability-compatible fallback under the same ceiling, based on approved spend. Do not pin the cheapest endpoint regardless of reliability. An over-tight ceiling may leave no endpoint, which needs an explicit blocked/retry outcome. Provider options, runtime construction, official price ceilings.

**Required improvement:** Enforce actual provider price constraints alongside latency preferences, and record the chosen endpoint/rate basis; reject or seek the required budget change rather than silently selecting a costlier endpoint.

**Acceptance to establish:** Supply faster endpoints above the approved price ceiling and slower eligible endpoints. Routing honors both semantics and explicit spend constraints and records the actual endpoint/rate used.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/provider.ts#L154-L211), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/connections.ts#L92-L140), [reference 3](https://openrouter.ai/docs/guides/routing/provider-selection#max-price), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/provider.ts#L101-L123)

### COST-05: P2. Improve reservations and cost evidence before tuning budgets

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Provider usage.cost is already authoritative, with token-rate/preflight estimates when absent; do not replace this with an advertised-price multiplication. Add upstream endpoint, reasoning tokens, cache-read/write tokens, retry identity, and quality outcome to private accounting. Preserve generation IDs for reconciliation. A timeout without final usage should remain uncertain until reconciled, not be labeled free. Keep operation ledger and provider invoice views distinct and do not add them together. Usage normalization, metering, cost tracking contract.

**Required improvement:** Reserve the prepared full request with schema/tool/reasoning overhead, persist unknown paid attempts and reconcile actuals by operation. Keep estimate, reservation, provider actual and invoice basis distinct.

**Acceptance to establish:** Measure reservations versus actual costs for long tool schemas, reasoning/cache usage, paid timeouts and metering outages. Unknown charges remain reconcilable and total attributable workload cost is reported.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L537-L553), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L811-L834), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/provider.ts#L101-L123), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L919-L1005), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/cost-tracking.md), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L687-L753), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1577-L1625), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L883-L978), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L899-L917), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L760-L894), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/provider.ts#L154-L211), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1361-L1410), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L600-L640), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L475-L512)

### COST-06: P2. Stabilize safe prefixes; reduce redundant evidence, not essential context

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Cache hints already exist. The executor rebuilds its system prompt as trust state, checklist and tool state change; this is necessary for safety but can invalidate prefixes. Put stable instructions first and changing task state later where the provider contract allows. Measure hit rates before claiming savings. Never retain private owner context after taint just to preserve a cache hit. Consider opaque task/session cache affinity only within existing provider/privacy authorization. Cache hints, prompt rebuild.

**Required improvement:** Stabilize reusable nonprivate or correctly scoped prompt prefixes and remove duplicate evidence without discarding material context; bind caches to owner, policy, source and model revision.

**Acceptance to establish:** Compare fixed long-context tasks with unchanged safe prefixes, changed user/source/permission/model revisions and duplicate evidence. Cache reuse never crosses scope and quality/coverage do not regress.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1361-L1410), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L600-L640), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/util.ts#L1-L65), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/util.ts#L163-L260), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L687-L753), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1577-L1625), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L883-L978), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L899-L917), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L760-L894), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L537-L553), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L811-L834), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L919-L1005), [reference 13](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L475-L512)

### COST-07: P2. Spend less reasoning only where the role passes without it

**Current status:** Open.

**Observed condition:** The router already disables optional reasoning for non-tool lightweight calls on verified models. It gives mandatory/unknown reasoning models headroom rather than starving their final answer. Preserve this distinction. Compare lower effort for simple tool decisions and Luna no-reasoning for extraction/drafts, but keep sufficient visible-output capacity. Hiding reasoning does not remove its bill. Current reasoning policy, official reasoning accounting.

**Required improvement:** Evaluate lower-reasoning settings by role using the real task corpus; retain required reasoning/capability headroom and promote only when quality and total outcome cost pass.

**Acceptance to establish:** Run paired role-specific no/low/default-reasoning evaluations, including difficult tool and source-grounding cases. Promote only non-regressing quality with measured total successful-outcome cost.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L475-L512), [reference 2](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L687-L753), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1577-L1625), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L899-L917), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L760-L894), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L537-L553), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L919-L1005), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1361-L1410)

### COST-08: Lower priority: avoid paid no-op extraction and embedding

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Email extraction already skips low-importance/short bodies and drains a stamped ledger. Keep that behavior. Add unchanged-source/version no-op detection, exact content-hash/tombstone screening before embeddings where safe, and reuse prepared extraction across persistence retry. Do not prune important mail merely for cost. The current batch role name denotes a logical role, not evidence that provider asynchronous batch discounts are used. Any later batching must preserve source attribution, failure isolation and required timing. Existing email gates.

**Required improvement:** Detect unchanged/no-op extraction or embedding work before paid calls and retain reusable prepared results; use explicit model-space and source-revision identity.

**Acceptance to establish:** Replay unchanged extraction/indexing sources and changed embedding spaces. Unchanged work avoids paid calls, while a real revision produces exactly the necessary fresh processing.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/email-extraction.ts#L236-L327)

### DESIGN-DECISIONS: Selective decision adapter and retrieval reranking, including Jev evaluation

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Some high-volume classification/ranking decisions may benefit from a small discriminative model; savings and quality are not established, and Jev is not a chat-completion model.

**Required improvement:** Add a separate typed Decisions adapter only for selected calibrated tasks; retain abstention, generative fallback and deterministic policy/effect validation.

**Acceptance to establish:** Compare fixed representative conversations and end-to-end outcomes in shadow, including ambiguity/negation/compound turns. Promote only with no critical regression and non-increasing total attributable cost after fallback/serving overhead.

Source references: [reference 1](https://openrouter.ai/typesafe/jev-1.13/), [reference 2](https://openrouter.ai/docs/guides/community/jev), [reference 3](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request), [reference 4](https://openrouter.ai/api), [reference 5](https://openrouter.ai/docs/guides/community/typesafe-sdk), [reference 6](https://docs.typesafe.ai/primitives), [reference 7](https://docs.typesafe.ai/api), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/provider.ts#L33-L51), [reference 9](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L734-L745), [reference 10](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L1490-L1523), [reference 11](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/model-providers.ts#L602-L619), [reference 12](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/model-providers.ts#L631-L661), [reference 13](https://docs.typesafe.ai/model-jaggedness/jev-1.13), [reference 14](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/model-config.ts#L108-L135), [reference 15](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/model-providers.ts#L623-L670), [reference 16](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-turn.ts#L230-L243), [reference 17](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-turn.ts#L577-L668), [reference 18](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/planner.ts#L68-L101), [reference 19](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/planner.ts#L233-L257), [reference 20](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L338-L377), [reference 21](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L380-L405), [reference 22](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-importance.ts#L23-L115), [reference 23](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-importance.ts#L142-L262), [reference 24](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L625-L694), [reference 25](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/modules/src/google/email-sync.ts#L705-L763), [reference 26](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/supersede.ts#L18-L35), [reference 27](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/supersede.ts#L67-L82), [reference 28](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/supersede.ts#L110-L181), [reference 29](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/voice.ts#L65-L70), [reference 30](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/voice.ts#L151-L216), [reference 31](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-triage.ts#L110-L155), [reference 32](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/read-intent.ts#L753-L830), [reference 33](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/read-intent.ts#L859-L916), [reference 34](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/planner.ts#L35-L52), [reference 35](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/planner.ts#L203-L231), [reference 36](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L645-L660), [reference 37](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/executor/step-loop.ts#L784-L809), [reference 38](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/schedules.ts#L78-L98), [reference 39](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/workflow/schedules.ts#L479-L510), [reference 40](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat-turn.ts#L548-L575), [reference 41](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/recall.ts#L78-L85), [reference 42](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/recall.ts#L149-L246), [reference 43](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/graph-recall.ts#L114-L198), [reference 44](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/commitments.ts#L347-L384), [reference 45](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/memory/graph-recall.ts#L214-L248), [reference 46](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L198-L275), [reference 47](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/proactive/pulse.ts#L746-L870), [reference 48](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/tools/src/question-regression/harness.ts#L736-L774), [reference 49](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/messaging-review-2026-09-29.md#L1-L31), [reference 50](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/model-router/router.ts#L928-L1001), [reference 51](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/cost-tracking.md)

### DM-02: PostgreSQL routing upgrades can replace custom settings outside the retired field

**Current status:** Partial; source changes and focused checks.

**Observed condition:** A role has a valid custom primary and retired fallback, or vice versa, plus owner parameters. An ordinary PostgreSQL reconcile replaces both models and params rather than repairing only the obsolete leg. Crossing 0019 also loses any preexisting custom extract choice. Referenced catalog models must exist when data-only migrations run; unlike 0041's batch insert, 0019 does not guard their presence. The fresh empty model-role table takes no update, so fresh-install tests need not detect the upgrade problem.

**Required improvement:** explicitly separate seed-owned defaults from owner-owned configuration, version the baseline and preserve untouched custom fields. Require a visible review for materially changed routing/budgets. Keep immutable applied 0019; use forward repair only with recoverable prior configuration and owner intent, not guessed reconstruction. Store before/after role revisions so future changes are reversible.

**Acceptance to establish:** custom primary plus retired fallback; retired primary plus custom fallback; custom params; owner-disabled catalog row; missing legacy catalog; untouched default; repeated reconcile; rollback using recorded baseline. Verify model identity, parameters and enabled state, not just row existence.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/drizzle/0019_extract_role_deepseek_primary.sql#L8-L11), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/model-config.ts#L137-L168), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/seed.ts#L47-L48), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/package.json#L17-L21), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/docs/model-routing.md#L27-L30), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/package.json#L13-L21), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/seed.ts#L197-L204)

### HC-10: Audit index cannot discover old owner tasks beyond bounded recent results

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Audit index accepts only filter/view/q, retrieves the latest 100 records first, then filters q in memory: audit/page.tsx:29–45 The UI accurately discloses that only the latest 100 records in the view are searchable: audit/page.tsx:93–103 Supported statuses are all, needs-you, working, scheduled and completed; there is no owner-request/type/source/date filter or index cursor: tasks/queries.ts:16–24,63–85 Queries order by updatedAt before applying the limit: tasks/queries.ts:105–114 Mobile Activity GET is fixed to 50 and also offers no discovery cursor/search: activity/route.ts:18–40 Detailed audit sections can page older records once a task ID is known, but contextMessages excludes taskId from its projection: audit-investigation.ts:62–63

**Required improvement:** Provide owner-scoped paginated/searchable audit discovery beyond the recent-result cap, with exact task/message/time identity, bounded reads and honest missing-capture status.

**Acceptance to establish:** Create more tasks/events than every recent limit, including equal timestamps. Find an old requested owner task with a stable cursor and exact identity; no silent bounded search implies absence.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/audit/page.tsx#L29-L45), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/audit/page.tsx#L93-L103), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/tasks/queries.ts#L16-L24), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/tasks/queries.ts#L105-L114), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/mobile/v1/activity/route.ts#L18-L40), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/persistence/src/audit-investigation.ts#L62-L63), [reference 7](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/web/app/api/chat/status/route.ts#L31-L66), [reference 8](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/chat.ts#L354-L373)

### IOS-21: Selecting another model can silently retain the previous model’s prices

**Current status:** Partial; source changes and focused checks.

**Observed condition:** In Add a model, choose a listed model with prices, then switch to one whose listing has a missing input or output price, or type an unmatched model name. The onChange handler returns for no match and only writes nonnil price fields for a match. The old prices remain filled, so Add model can persist model B with model A’s rates without an explicit manual-price decision. This can understate preflight reservations and token-rate cost accounting. Successful OpenRouter provider-reported actual cost is a separate authoritative path and is not claimed to be replaced by these rates.

**Required improvement:** Bind price provenance to model identity; clear missing/unmatched prices on identity change, fill only the selected model’s current listing values, and require deliberate manual entries when unavailable. Server-side validation should distinguish authoritative provider prices from owner-entered estimates.

**Acceptance to establish:** Priced A→unpriced B, priced A→custom B, one-sided missing price, search edits and listing refresh. No stale A rate is submitted for B; pricing source is visible and budgeting uses the saved B rates.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/AIProvidersView.swift#L397-L408), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/apps/ios/Assistant/Views/AIProvidersView.swift#L418-L449), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/application/src/model-providers.ts#L554-L622)

### PG-07: Accepted maximum task budget cannot fit the PostgreSQL field

**Current status:** Partial; source changes and focused checks.

**Observed condition:** Both increase paths accept 10,000 inclusive. numeric(8,4) holds at most 9999.9999, so an otherwise valid $10,000 retry fails with numeric overflow. New-task validation already rejects >=10,000, making paths inconsistent. Impact: failed owner retry at the advertised cap, no successful budget change. Fix a shared numeric money validator matching field precision (or widen schema consistently), including quantization boundaries. Test 9999.9999, 9999.99995, 10000 and values rounding to the ceiling against both backends and API validation.

**Required improvement:** Use one strict money validator whose quantization and upper bound fit the PostgreSQL column and supported API contract, or widen the schema consistently through a reviewed migration.

**Acceptance to establish:** Exercise 9999.9999, 9999.99995, 10000 and rounding-to-ceiling values through create, retry and increase on both adapters. Validation and persisted money agree without numeric overflow.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/application-chat-repository.ts#L682-L704), [reference 2](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/task-lifecycle-repository.ts#L269-L285), [reference 3](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/schema.ts#L483-L486), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/application-chat-repository.ts#L88-L133), [reference 5](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/schema.ts#L1096-L1099), [reference 6](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/db/src/schema.ts#L234-L254)

### DESIGN-HORIZON: Responsive voice and bounded delegated outcomes over the existing runtime

**Current status:** Design proposal; implementation open.

**Observed condition:** The user wants substantially better spoken interaction and practical follow-through. Existing local Talk and outbound calls are real foundations; newer public APIs do not establish account entitlement or measured app quality.

**Required improvement:** Repair current voice/call contracts, keep local Talk as baseline, evaluate GPT-Live client delegation over the existing backend, then qualify narrow legally eligible/consenting phone errands and durable multi-day outcomes.

**Acceptance to establish:** Pass deterministic authority/crash/cost tests, physical-device speech corpus and a scoped consenting-recipient telephony pilot. Compare verified task completion, owner effort, latency and full cost; no universal autonomy or unsupported 10× claim.

Source references: [reference 1](https://developers.openai.com/api/docs/guides/live-delegation), [reference 2](https://developers.openai.com/api/docs/guides/voice-agents), [reference 3](https://developers.openai.com/api/docs/models/gpt-live-1), [reference 4](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/phone-call.ts#L34-L181)

### VH-01: Existing call transcription default needs a dated provider migration

**Current status:** Partial; source changes and focused checks.

**Observed condition:** The OpenAI call adapter defaults to gpt-4o-mini-transcribe; the official deprecation notice lists removal on 2027-02-26. Active owner-selected/default routes are not inventoried here.

**Required improvement:** Inventory deployed transcription and legacy voice routes; qualify a supported replacement with exact Realtime events, usage and language/entity accuracy before the deadline. Preserve route/revocation semantics.

**Acceptance to establish:** Synthetic provider contract and approved audio corpus cover configuration acceptance, transcript events, critical names/amounts, error and cost handling. Verify the actual deployed route has migrated before 2027-02-26.

Source references: [reference 1](https://github.com/bmson/assistant/blob/ce348d48ef0a9629907873e79c0c97a9ed891f11/packages/core/src/realtime-voice/openai.ts#L110-L269), [reference 2](https://developers.openai.com/api/docs/deprecations)


## Execution packets

Each packet retains its original prerequisites, non-goals and acceptance conditions in the local source inventory. All packets are accounted for; none is certified complete as a packet.

| Packet | Scope |
| --- | --- |
| P00 | P00 Make verification disposable and record the baseline |
| P01 | P01 Fix native Stop unknown outcomes and audio privacy |
| P02 | P02 Bind operations triggers and continuations |
| P03 | P03 Interpret the whole request before routing |
| P04 | P04 Bind authority approval and current policy |
| P05 | P05 Persist batches effects and replay identity |
| P06 | P06 Make owner delivery durable and truthful |
| P07 | P07 Repair temporal work and effective outcomes |
| P08 | P08 Fence erasure lineage and every privacy projection |
| P09 | P09 Make ingestion extraction and coverage recoverable |
| P10 | P10 Repair knowledge identity corrections and temporal meaning |
| P11 | P11 Compose relevant complete and concise answers |
| P12 | P12 Admit useful initiative through one attention policy |
| P13 | P13 Enforce complete bounded tool and transport contracts |
| P14 | P14 Unify provider attempts without losing safe recovery |
| P15 | P15 Measure economics and qualify selective decisions |
| P16 | P16 Make native state and accessibility reflect one outcome |
| P17 | P17 Add bounded native composition after contract repair |
| P18 | P18 Contain code execution and protected repair paths |
| P19 | P19 Repair supported setup migrations activation and restore |
| P20 | P20 Make release cutover and rollback evidence bound |
| P21 | P21 Repair administration and keep dormant surfaces gated |
| P22 | P22 Repair current call lifecycle transcripts and billing |
| P23 | P23 Qualify future voice and bounded delegated outcomes |
| P24 | P24 Prove composed journeys and control rollout |

## Acceptance journeys

Journey coverage is a separate gate from file coverage and focused regressions. These journeys are retained for implementation and qualification; they have not all been executed.

| Journey | Scope |
| --- | --- |
| F01 | F01 Claim and pair an installation |
| F02 | F02 Resume an existing connection |
| F03 | F03 Discover capabilities and connect services |
| F04 | F04 Configure model provider and roles |
| F05 | F05 Add review a remote tool connection |
| F06 | F06 Permission prompts and device settings |
| F07 | F07 Ordinary and abstract discussion |
| F08 | F08 Real personal lookup |
| F09 | F09 Mixed answer and action |
| F10 | F10 Draft quote edit translate |
| F11 | F11 Clarification with partial answers |
| F12 | F12 Short replies and approvals |
| F13 | F13 Multi turn correction |
| F14 | F14 Recall an earlier decision |
| F15 | F15 Ask what happened historically |
| F16 | F16 Admit one request |
| F17 | F17 Execute bounded practical work |
| F18 | F18 Review edit approve deny |
| F19 | F19 Stop active work |
| F20 | F20 Resume after interruption |
| F21 | F21 Recover model provider failure |
| F22 | F22 Budget decision and recovery |
| F23 | F23 Create change cancel reminder |
| F24 | F24 Long horizon goal or watch |
| F25 | F25 Finish archive hide dismiss |
| F26 | F26 Learn useful information |
| F27 | F27 Correct confirm pin and forget |
| F28 | F28 Resolve people and relationships |
| F29 | F29 Open loops and goal progress |
| F30 | F30 Useful in conversation initiative |
| F31 | F31 Proactive issue detection and lifecycle |
| F32 | F32 Cross producer attention |
| F33 | F33 Accept snooze dismiss suggestion |
| F34 | F34 Saved card and situation pack |
| F35 | F35 Documents and backstory |
| F36 | F36 Compose a new native interface |
| F37 | F37 Interact refresh and replay a card |
| F38 | F38 Stream and reconnect rich content |
| F39 | F39 Move around while work continues |
| F40 | F40 Dictate edit and send |
| F41 | F41 Talk and read aloud |
| F42 | F42 Outbound call task later phase |
| F43 | F43 Notification badge and Live Activity |
| F44 | F44 Accessibility and semantic fallback |
| F45 | F45 Export erase and retention |
| F46 | F46 Location aware help |
| F47 | F47 Cost visibility and controls |
| F48 | F48 Audit and investigate |
| F49 | F49 Report and repair an issue |
| F50 | F50 Pause schedules revoke autonomy disconnect |
| F51 | F51 Install update restore and operate |
| F52 | F52 Receive work through email SMS |
| F53 | F53 Learn and apply writing voice |
| F54 | F54 Inspect and edit skills |
| F55 | F55 Review anomalies and standing rules |
| F56 | F56 Deliver or share an artifact |

## Verification evidence

All seven originals and 246 canonical findings remain accounted for: 232 Partial, 10 Implemented and locally verified, 2 Open, 1 Proposal and 1 Withdrawn. No finding is promoted at this checkpoint. Partial describes outstanding acceptance conditions, rather than a percentage of features still missing.

The web form workflow and mobile admission endpoint are installed, together with the complete reviewed native client. Review places answers in the ordinary editable composer; Send admits the reviewed request. Edited drafts survive reload, uncertain sends retain their frozen operation and request bytes, and separate owner replies do not change the exact form task. The root repair releases foreground composer state only for its own terminal form task. Native support is negotiated only after the renderer and encrypted session are ready; older clients and unsupported forms retain readable fallback content.

The installed browser lifecycle runner passed nine mounted scenarios at source 429f109ec27f5e665b0fa934b240fac924e186503e178519476f389454fe6d04, retaining eight independent UUID task records and 20 transition records, including rejected terminal regression. No page or console errors were recorded. This uses fake loopback transport, without real authentication, service, persistence or provider execution. The current focused web/mobile capability suite passed 66/66 methods across 12 files and 29 Vitest suites at source 87d72970c65558cfd3449a6e1cf81b98e13086792fecade73a028b89b2acc14a (3,654 files). The earlier missing test import caused three failures and was corrected; those failing receipts remain preserved.

The v15 actual-CSS component run passed all 50 state/layout combinations and produced 97 images at source 429f109e. Root recomputed all image hashes; independent review inspected all 88 unique original pixel payloads, with nine exact duplicates. All 20 enlarged-text scroll groups have positive overlapping viewport tiles, complete heading/action visibility and a fully visible viewport for every selected-value caption. Captions retain full date/choice values and their aria-describedby relationship through edits and narrow/wide resizing. Typography and control sizes are preserved. This is synthetic Chromium component evidence, not an authenticated route, native UI, browser zoom, OS Dynamic Type or screen-reader certification. Earlier v8/v11 invalid scroll captures and intrinsic native-control clipping are retained as historical failures; the caption supplies the complete selected value.

The installed native v18 client matches the reviewed candidate, apart from formatter-only changes to four shared TypeScript files and a corrected test import. Its unsigned shadow build-for-testing passed, executing zero XCTest methods. The portable host passed 43 coordinator/storage methods, and its actual encrypted disk roundtrip passed in three separate processes. A later portable host with exact production parser/models and reviewed production helper slices passed 47/47 methods: 31 coordinator, 12 storage and four parser/catalog. These totals overlap and are not additive. The macOS disk failure was isolated to unsupported file-protection attribute operations; iOS retains complete protection at directory and file creation/reset. Portable evidence does not establish iOS protection or production Keychain behavior. The selected iOS simulator test attempt timed out after 300 seconds with service-hub handshake errors before any XCTest method started. No native runtime or physical-device acceptance is claimed.

All five current static/build checks passed at source 340df1a11747652571770cd2b8a46e7d59cdd572167186519e70d35bc3d54494 (3,655 files): forced package typechecks, scripts typecheck, lint, whitespace check and production build. The source stayed unchanged and the local environment was restored. The verification-harness type assertion emits byte-identical JavaScript. A new actual mobile form route plus real mobile-auth predicate composition passed eight cases; the combined auth/route qualification passed 24/24 at the same current source. Only underlying owner-session, installation-config, secret-lookup and application ports are safe fixtures. Hostile, missing and null cookie Origins reject before body parsing; exact origin still requires an authenticated owner, and the valid bearer path works without Origin. This does not qualify a live authenticated installation.

The eligible repository run at source 87d72970 reached its 1,200-second limit before completing, with unchanged source and quiescent owned processes. Its log records 218 completed suites containing 2,034 passing methods; no completed suite is reported failed, but no Vitest JSON summary or complete aggregate result exists. These are partial observed results, not a whole-tree pass. The interrupted run left one new isolated test database; root checked zero active connections, removed only that target, and verified all 13 preexisting targets remain. Separate smaller continuation runs are being prepared with the same eight provider-gated exclusions. The preceding focused foundation run passed 107/110 before the missing-import correction; its failures and cleanup receipt remain historical.

Read-only follow-up review identified HC-01 cancellation before task receipt: ordinary clients retain honest unknown state but cannot yet place a durable operation-keyed stop before admission. The reviewed design reuses the existing task operation key, preserves dispatch ordering and unknown effects, and explicitly separates form requests from ordinary sends. The persistence implementation is being staged outside the checkout; no HC-01 completion is claimed.

No live provider call, managed cloud restore, Firestore activation, PostgreSQL retirement, deployment, signed phone installation or commit is claimed. All original acceptance journeys remain subject to their stated gates. The Word playbook was regenerated for this checkpoint and all 168 page images were reviewed; its exact document hash and visual QA record are preserved in current-form-playbook-v6-root-published/receipt.json. Work continues toward a usable phone checkpoint and the broader original acceptance conditions.

## Implementation evidence index

274 local workstream reports describe the concrete changes, focused checks and remaining acceptance conditions. Historical report snapshots do not replace final combined qualification. Private reports remain ignored by Git; the following links open the retained local evidence.

- [Current local qualification and remaining acceptance](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/final-independent-qualification-status.md)
- [Current implementation and verification checkpoint](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/root-checkpoint-status.md)
- [API-06 task activity mutation outcomes](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/API06-status.md)
- [API-09 follow-up status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/API09-followup-status.md)
- [API-09 import history growth](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/API09-import-history-growth-status.md)
- [API-09 workspace section availability status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/api09-status.md)
- [APP-03 implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/app03-status.md)
- [APP-04 owner-step receipt follow-up](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/APP04-owner-step-receipt-status.md)
- [APP04 shared PostgreSQL maintenance](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/APP04-status.md)
- [APP-07 and HM01 implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/app07-hm01-status.md)
- [AUX-AUDIT-PRIVACY URL and field-aware source minimization](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/AUDIT-PRIVACY-status.md)
- [Owner authority and bounded source reads](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/authority-read-integration-status.md)
- [Authority boundary implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/authority-status.md)
- [Additional bounded mobile request repair, 2026-10-07](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/AUX-API-PARSING-status.md)
- [AUX-CONTRACT-SHAPES exact local acceptance](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/AUX-CONTRACT-SHAPES-local-acceptance-status.md)
- [Historical migration upgrade status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/AUX-MIGRATIONS-status.md)
- [AUX-TOOLS-READS scoped implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/AUX-TOOLS-READS-status.md)
- [AUX-VOICE-CONTRACT current source review](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/AUX-VOICE-CONTRACT-current-status.md)
- [Browser and emulator timeout follow-up status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/browser-timeout-followup-status.md)
- [Calendar and two broad-failure followup](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/calendar-and-two-broad-failure-current-status.md)
- [MC-12 atomic owner call admission](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/call-admission-status.md)
- [Canonical graph source deletion and owner-review retention](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/canonical-graph-cleanup-status.md)
- [Form server admission and current qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/card-form-server-admission-status.md)
- [Current implementation and verification checkpoint](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/card-icon-grid-status.md)
- [Current implementation and verification checkpoint](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/card-refresh-controls-status.md)
- [Saved-card refresh revision and retry candidate v2](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/card-refresh-web-revision-stage-v2-status.md)
- [Native card compatibility recovery for unknown payloads](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/card-unknown-fallback-status.md)
- [CC-02 consumer readiness provenance and delivery](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/CC-02-status.md)
- [CC-03 cutover crash recovery test status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/CC03-cutover-crash-recovery-status.md)
- [CF-05 status: chat admission retry identity](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/cf05-status.md)
- [CF-06 implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/CF06-status.md)
- [CF-07 Mission cadence and recursive-budget status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/cf07-status.md)
- [Chat erasure publication test recall-fixture audit (read only)](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/chat-erasure-recall-fixture-status.md)
- [Context continuity and informational follow-up qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/clean-intent-context-quality-status.md)
- [Compact header and conversation-search adapter static qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/compact-header-adapter-static-status.md)
- [Focused completion audit: 10 high-priority findings](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/completion-audit-status.md)
- [Firestore index-readiness test repair](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/consumer-index-readiness-repair-status.md)
- [Contextual recall implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/CONTEXT-FRAME-status.md)
- [Prepared contextual UX fixture patch (not applied or verified)](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/context-multiturn-ux-fixture-patch-status.md)
- [DESIGN-CONTEXT-UX multi-turn integration evidence](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/context-multiturn-ux-status.md)
- [DESIGN-CONTEXT implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/context-surfacing-status.md)
- [AUX CONTRACT SHAPES implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/CONTRACT-SHAPES-status.md)
- [Conversation search and compound request completion](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/conversation-search-checklist-status.md)
- [Corrected graph and raw-memory retrieval qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/corrected-retrieval-status.md)
- [Model cost and preparation findings](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/COST-status.md)
- [COST-08 generic completed-corpus refresh status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/COST08-refresh-status.md)
- [Latest acceptance checkpoint](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/current-acceptance-gap-ledger-status.md)
- [Current acceptance review: canonical findings 1–82](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/current-acceptance-review-001-082-status.md)
- [Current acceptance audit: findings 83–164](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/current-acceptance-review-083-164-status.md)
- [Current acceptance source/case review: findings165-246](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/current-acceptance-review-165-246-status.md)
- [Current console visual review — 2026-10-08](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/current-console-visual-review-status.md)
- [Current implementation and verification checkpoint](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/current-literal-acceptance-executed-status.md)
- [Current provider qualification boundary](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/current-provider-qualification-boundary-status.md)
- [CC-05 cutover retirement readiness status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/cutover-retirement-status.md)
- [Cutover and consumer-update findings](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/cutover-status.md)
- [DESIGN-COMPOSITION (P17) status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/DESIGN-COMPOSITION-status.md)
- [DESIGN-CONTEXT situation decision recall status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/design-context-status.md)
- [Selective decision adapter status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/DESIGN-DECISIONS-status.md)
- [DESIGN-KNOWLEDGE implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/DESIGN-KNOWLEDGE-status.md)
- [DM-02 / DM-03 configuration ownership status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/DM02-DM03-status.md)
- [DM-04 native-first consumer handoff](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/DM04-status.md)
- [DM-05 / DM-07 local follow-up](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/DM05-DM07-local-qualification.md)
- [DM06 actual snapshot restore qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/DM06-current-snapshot-executed-status.md)
- [DM-06 restore drill candidate v2 — staged, not executed](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/DM06-restore-drill-candidate-v2-status.md)
- [DM-06 restore drill candidate v3 — staged, not executed](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/DM06-restore-drill-candidate-v3-status.md)
- [Documentation and recovery follow-up — 2026-10-07](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/docs-recovery-followup.md)
- [Dream and voice focused verification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/dream-voice-focused-status.md)
- [MC-04 authenticated email admission status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/email-admission-status.md)
- [Prepared email extraction identity test alignment (not yet run)](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/email-extraction-space-change-fixture-status.md)
- [Embedding fixture repair status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/embedding-fixture-repair-status.md)
- [Privacy and deletion implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/erasure-status.md)
- [Executor-backed contextual UX and erasure status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/executor-ux-erasure-status.md)
- [Final agent regression fixes](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/final-agent-regressions-status.md)
- [Final completeness cross-check](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/final-completeness-check-status.md)
- [Final core regression repairs](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/final-core-regressions-status.md)
- [Current delivery integrity and custody](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/final-delivery-integrity-status.md)
- [Final graph recall repair status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/final-graph-recall-repair-status.md)
- [Card-form stale-native-foundation checkpoint](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/final-independent-qualification-status.md)
- [Final native acceptance evidence review](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/final-native-acceptance-status.md)
- [Privacy export regression follow-up](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/final-privacy-regressions-status.md)
- [Final release, migration, and recovery evidence audit](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/final-release-evidence-status.md)
- [Final coverage disposition](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/finalcoverage-status.md)
- [Prepared follow-up Firestore fixture patches (unapplied)](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/firestore-followup-fixture-patch-status.md)
- [Prepared Firestore identity-fixture patches (unapplied)](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/firestore-identity-fixture-patch-status.md)
- [Firestore import restart after completed purge](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/firestore-import-restart-status.md)
- [Firestore memory extraction fixture patch prepared](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/firestore-memory-extraction-fixture-patch-status.md)
- [Firestore memory projection normalization](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/firestore-memory-projection-status.md)
- [APP-01 Firestore heavy-document processor status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/firestore-processor-status.md)
- [Firestore emulator regressions and MC-03 provenance update](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/firestore-regressions-mc03-status.md)
- [FS-04 Gmail lease fencing implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/fs04-status.md)
- [FS-07 / HM17 implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/FS07-HM17-status.md)
- [FS08: commitment lifetime history, correction duplicates and occurrence identity](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/FS08-status.md)
- [FS-10 occasion identity status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/FS10-status.md)
- [FS13 callback retry receipt integration](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/FS13-callback-replay-status.md)
- [FS-13 callback replay staged patch](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/FS13-staging-status.md)
- [FS14 actual extraction and voice writer erasure races](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/FS14-writer-races-status.md)
- [FS-15 migration write packing](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/FS15-status.md)
- [FS-18 implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/fs18-status.md)
- [FS-19 follow-up: oversized passage continuation](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/FS19-followup-status.md)
- [FS-19 document detail pagination status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/fs19-status.md)
- [HC-08 future-notification routing and receipt status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/future-watch-status.md)
- [Generic card form prototypes — staged only](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/generic-card-form-prototype-status.md)
- [Generic form primary review — not approved for product integration](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/generic-form-primary-review-blockers-status.md)
- [HC-05 — clarification after source discovery](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HC05-status.md)
- [HC-06 mail lookup coverage](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HC06-status.md)
- [HC-09 status: source-backed email obligation lifecycle](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HC09-status.md)
- [HC-09 current-thread freshness and admission follow-up](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HC09-thread-refresh-status.md)
- [HC-10 historical owner audit discovery](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HC10-status.md)
- [HC-12 status: owner intent and tainted source](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HC12-status.md)
- [Current local qualification and remaining acceptance](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/historical-before-search-refresh-final-independent-qualification-status.md)
- [HM02 obligation maintenance](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HM02-status.md)
- [HM04 — atomic document callback consumption and final-attempt fencing](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HM04-status.md)
- [HM05 import removal and erasure status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HM05-bounded-import-deletion-status.md)
- [HM05 / FS-14 Firestore owner-erasure lineage cleanup](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HM05-firestore-owner-erasure-status.md)
- [HM05 Firestore import cleanup retry status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HM05-firestore-retry-status.md)
- [HM05 import lineage and deletion status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HM05-lineage-status.md)
- [HM07 — temporal and uncertainty invariants in consolidation](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HM07-status.md)
- [HM08 / HM09 graph extraction status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/hm08-hm09-status.md)
- [HM-09 source-scope follow-up](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/hm09-scope-followup-status.md)
- [HM10 calendar source lifecycle](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HM10-status.md)
- [HM11 reminder candidate selection](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HM11-status.md)
- [HM12 contextual bearer link projection repair](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HM12-alternate-secrets-status.md)
- [HM15 / HM16 status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HM15-HM16-status.md)
- [HM18 SQL skill-reflection race status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/hm18-status.md)
- [HM21 — Transient location and durable arrival tasks](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HM21-status.md)
- [HM23: atomic curiosity question and push admission](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/HM23-status.md)
- [Gmail sync ingress status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/ingress-status.md)
- [IOS-13 — actual-run identity for native review exports](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/IOS13-status.md)
- [IOS-22 first proposal review](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/ios22-v1-root-review-status.md)
- [Current map contract request and interface qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/map-contract-intent-current-qualification-status.md)
- [AUX-MAPS-SPORTS source coverage and transport scope](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/MAPS-SPORTS-status.md)
- [MC-02 call completion durability](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/mc02-status.md)
- [MC-03 email provenance and authorization status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/MC03-email-provenance-status.md)
- [MC08 actual composition and immutable router receipt](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/MC08-composed-identity-status.md)
- [MC08 immutable embedding identity — Firestore and PostgreSQL adapter follow-up](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/MC08-firestore-identity-status.md)
- [MC08 implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/MC08-status.md)
- [MC-09 SMS segment accounting status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/MC09-status.md)
- [MC-10 final channel delivery and FS-13 callback boundary](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/mc10-status.md)
- [MC-11 implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/MC11-status.md)
- [AUX-TOOLS-MCP bounded matching and unknown effects](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/MCP-status.md)
- [Memory extraction findings status (2026-10-07)](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/ME-status.md)
- [Mermaid and approval visual follow-up](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/mermaid-approval-visual-qa-followup-status.md)
- [Mermaid caption and approval detail label visual QA](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/mermaid-approval-visual-qa-status.md)
- [Migration 0112 and release qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/migration112-qualification-status.md)
- [P05 mission-session correctness status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/mission-status.md)
- [API-04 multipart upload status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/multipart-upload-status.md)
- [Native iPhone UI review — 2026-10-07](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/native-app-ui-review-2026-10-07.md)
- [Approval header accessible layout v2 visual qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/native-approval-header-v2-visual-status.md)
- [Native approval header visual qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/native-approval-header-visual-status.md)
- [Native pull-menu A5 grid proposal — v5](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/native-chat-menu-a5-grid-status.md)
- [Pull-menu Dynamic Type visual qualification (applied reviewed change)](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/native-chat-menu-final-visual-status.md)
- [Native current-context visual status, v2](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/native-current-context-v2-status.md)
- [Native Foundation model qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/native-foundation-host-qualification-status.md)
- [Generated metric responsive grid visual qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/native-generated-metric-final-visual-status.md)
- [Generated card metric v4 visual review](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/native-generated-metric-v4-visual-status.md)
- [Native long-metric typography baseline](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/native-long-metric-baseline-status.md)
- [Native paging and recall-source controls](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/native-pagination-status.md)
- [RootView launch wash proposal](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/native-root-launch-wash-status.md)
- [Native settings label style visual review](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/native-settings-label-visual-status.md)
- [Native iOS implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/native-status.md)
- [Native visual QA route without XCTest transport](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/native-visual-host-alternative-status.md)
- [Native iPhone visual consistency pass](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/native-visual-polish-status.md)
- [Additional root implementation wave](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/new-wave-status.md)
- [Next required local gaps: read-only acceptance audit](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/next-required-local-gaps-status.md)
- [APP-09 notification delivery status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/notification-status.md)
- [OPS-09 safe goal-session rehearsal](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/OPS-09-status.md)
- [OPS-01/06/07/08 release and phone setup review](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/ops-followup-status.md)
- [OPS-01 / TW-18 code-runner isolation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/ops01-tw18-code-runner-status.md)
- [OPS-03 renamed authentication path guard](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/OPS03-security-name-guard-status.md)
- [OPS-09 — rehearsal isolation and orphan recovery](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/OPS09-status.md)
- [OPS-11 — independent service release safety](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/OPS11-status.md)
- [OPS-14 demo fixture lifecycle](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/OPS14-demo-lifecycle-status.md)
- [OPS-15 phone setup: staged routing and durable interruption recovery](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/OPS15-phone-lifecycle-status.md)
- [OPS-16 and OPS-17 current-source review](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/OPS16-17-current-status.md)
- [OPS-16 fixture isolation and recall exclusion follow-up](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/OPS16-fixture-isolation-status.md)
- [OPS-17 visual evidence provenance](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/OPS17-status.md)
- [Current owner-fixture behavior and retired-skill visual checkpoint](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/owner-fixture-red-and-retired-visual-current-status.md)
- [Ordered owner request handling](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/owner-intent-ordered-compound-status.md)
- [P18 local code-runner hardening status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/p18-local-hardening-status.md)
- [PG05 asynchronous memory save generation and card compilation](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/PG05-memory-save-generation-status.md)
- [PG-07 complete web task-budget input](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/PG07-web-budget-status.md)
- [Prepared memory extraction: restart identity](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/prepared-memory-restart-identity-status.md)
- [Firestore primary-chat read idempotence](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/primary-chat-idempotence-status.md)
- [Privacy qualification and durable report redaction](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/privacy-report-redaction-status.md)
- [Prepared privacy-writer race fixture patch (not applied or verified)](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/privacy-writer-races-fixture-patch-status.md)
- [OPS-04 private callback audience alignment](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/private-callback-status.md)
- [Local production build verification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/production-build-status.md)
- [PROV-01 / PROV-02 self-repair recovery status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/PROV01-02-status.md)
- [PROV-02 generic model-router attempt evidence](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/PROV02-status.md)
- [PROV-03 / COST-03 / COST-04 implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/prov03-cost03-cost04-status.md)
- [PROV-04 deterministic repair notices](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/PROV04-status.md)
- [Provider and Slides implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/provider-status.md)
- [Calendar occurrence and conflict evidence status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/PS01-status.md)
- [PS-02 / PS-05 implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/PS02-PS05-status.md)
- [PS-03 / PS-04 status: security incident attention boundary](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/PS03-PS04-status.md)
- [PS-04 cross-producer synthetic-day follow-up](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/PS04-cross-producer-status.md)
- [PS-04 dismissal and briefing publication follow-up](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/PS04-dismissal-publication-followup-status.md)
- [PS-04 Firestore cancellation refresh regression](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/PS04-firestore-cancellation-followup-status.md)
- [Qualification test fixes owned by verification_setup](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/qualification-owned-fixes-status.md)
- [Qualification repair status (2026-10-07)](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/qualification-repairs-status.md)
- [Quoted-history positive PG diagnostic](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/quoted-history-positive-pg-diagnostic-status.md)
- [R1 durable mixed-call continuation follow-up](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/R1-followup-status.md)
- [R11 relational grounding status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/R11-status.md)
- [R15 calendar display qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/R15-calendar-display-status.md)
- [R3 / CF-02 implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/R3-CF02-status.md)
- [R3 mission dead-letter recovery status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/R3-dead-letter-status.md)
- [R4: atomic goal replacement and owner continuation guards](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/R4-status.md)
- [R6 Firestore maintenance receipt-purge test repair](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/R6-firestore-maintenance-repair.md)
- [R6 retention and compact effect receipts: current status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/R6-retention-followup-status.md)
- [R9 and R12 — calendar request windows and destination selection](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/R9-R12-status.md)
- [`tools.read_result` freshness guard — staged status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/read-result-refresh-guard-status.md)
- [Prepared recall scenario identity patch (not applied or verified)](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/recall-source-scenarios-fixture-patch-status.md)
- [Reviewed schema116 release qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/release-schema116-status.md)
- [Schema 117 local release qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/release-schema117-status.md)
- [Current implementation and verification checkpoint](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/root-checkpoint-status.md)
- [Root implementation scope and evidence](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/root-status.md)
- [Firestore runtime-data preflight test patch (staged only)](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/runtime-data-preflight-patch-status.md)
- [Final delivery integrity check](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/schema115-historical-delivery-integrity-status.md)
- [Final local qualification and remaining acceptance](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/schema115-qualified-independent-status.md)
- [Current local qualification and remaining acceptance](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/schema116-historical-final-independent-qualification-status.md)
- [Current local qualification and remaining acceptance](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/schema116-post-guard-pre-final-repair-final-independent-qualification-status.md)
- [Current local qualification and remaining acceptance](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/schema116-pre-guard-independent-status.md)
- [Schema 118 migration and release contract qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/schema118-migration-and-release-status.md)
- [Schema119 aggregate read-only diagnosis in progress](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/schema119-aggregate-diagnosis-status.md)
- [Current static qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/schema119-fieldpath-static-status.md)
- [Schema 119 fixture repairs](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/schema119-five-fixture-repair-status.md)
- [Schema 119 fixture corrections: import and erasure](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/schema119-import-erasure-fixture-status.md)
- [Schema119 release and upgrade qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/schema119-migration-and-release-status.md)
- [Schema119 repaired-source static qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/schema119-repaired-static-status.md)
- [Schema 119 static qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/schema119-static-qualification-status.md)
- [Schema 119 static qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/schema119-static-status.md)
- [Internal sweep and PostgreSQL segmentation fixture update](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/schema119-sweep-segmentation-fixture-status.md)
- [Schema 119 terminal fixture repairs (focused scope)](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/schema119-three-fixture-repairs-status.md)
- [Conversation search erasure identity adapter status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/search-adapter-status.md)
- [Resumed conversation search — current local qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/search-refresh-final-composed-status.md)
- [Staged test fixture fixes for search refresh / `tools.read_result`](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/search-refresh-test-types-fix-status.md)
- [Consumer setup, index readiness, environment example, migration guard status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/setup-index-migration-status.md)
- [Setup, verification, and release work status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/setup-status.md)
- [Setup and verification validation](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/setup-validation-status.md)
- [Shared form foundation and current qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/shared-card-form-contract-status.md)
- [Installation owner boundary status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/SINGLE-OWNER-status.md)
- [Original attachment and requirement custody](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/source-custody-qualification-status.md)
- [Staged literal acceptance followups — October 8](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/staged-literal-acceptance-current-status.md)
- [P05 R1 — Multi-call suspension status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/suspension-status.md)
- [Generic task parent ownership repair](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/task-parent-owner-status.md)
- [AUX-TOOLS-IDENTITY operation identity and partial completion](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/TOOLS-IDENTITY-status.md)
- [TW-03 approved-call claim fence status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/TW03-claim-fence-status.md)
- [TW-05 extraction structure metadata through the catalog](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/TW05-catalog-metadata-status.md)
- [TW-08 — audit-derived report approval](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/TW08-status.md)
- [TW-14 / TW-15 calendar coverage and mutation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/tw14-tw15-status.md)
- [TW-19 — Google spreadsheet tab coverage](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/TW19-status.md)
- [Minimal UI duplicate-title cleanup and actual visual qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/ui-copy-cleanup-current-status.md)
- [Current UI, cost and recovery qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/ui-money-current-qualification-status.md)
- [UI requirement trace review](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/ui-requirement-trace-status.md)
- [VH-01 — supported OpenAI transcription default](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/VH01-status.md)
- [VH-02 — call cost ledger and reconciliation](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/VH02-status.md)
- [VH-03 status — outbound voice playback accounting](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/VH03-status.md)
- [VH-04 status — call transcript batches and check-in offers](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/VH04-status.md)
- [Firestore long writing-sample lookup](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/voice-long-text-status.md)
- [MC-01 call voice route implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/voice-route-status.md)
- [Watch delivery and suggestion status (R14, MC-13, FS-12)](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/watch-status.md)
- [Web Audit and compact header QA](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/web-audit-compact-header-status.md)
- [WEB-14/15/16 response-card implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/web-card-status.md)
- [Current web card typography review](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/web-card-typography-current-status.md)
- [Retained web controls: current source evidence](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/WEB-controls-current-status.md)
- [Web/API security implementation status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/web-security-status.md)
- [Web supporting-label refinement prepared](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/web-supporting-labels-patch-status.md)
- [Web UI polish — focused evidence](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/web-ui-polish-status.md)
- [WEB-02 exact local acceptance audit](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/WEB02-local-acceptance-status.md)
- [WEB-10 scoreboard timer and lifecycle status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/web10-scoreboard-status.md)
- [WEB-13 actual chat admission browser qualification](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/WEB13-chat-admission-status.md)
- [WEB14 card compatibility and private rendering](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/WEB14-card-compatibility-status.md)
- [WEB14 native generated-card contract parity](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/WEB14-native-parity-status.md)
- [WEB14 specialized-card admission status](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/WEB14-specialized-admission-status.md)


## Browser and iPhone testing checkpoint, 2026-10-08

The HC-01 web and native callers are now installed. The browser mounted runner passed six actual ChatClient/AI SDK scenarios at source `64a276cf58735e84a17930690cac0cfbb25b795da0990ffc1ec12bdc2607db83`: exact ordinary Stop identity, retained unknown cancellation and explicit retry, task-terminal polling, cancellation-first admission rejection, late old-operation fencing, and protected pre-receipt form admission. Transport is controlled and CSS is omitted; this is not live-provider or physical-device acceptance. The focused preview regression passed 281/281 tests without skips at `eea7807d26ae9a19ca04c212a4112403a27d50726cab80375a7ce337c7cfa21a`. The only following runtime-source change was a type-safe harness property setter. All five static/build checks passed at `64a276cf`, with unchanged source and restored local environment.

The five installed native Stop files match the reviewed v3 candidate and passed a read-only APIError/identity/form-fence audit. No current native build or XCTest/device execution is claimed by that audit. A separately staged signed physical-phone procedure is under root review.

User testing uses a dedicated local PostgreSQL database and a private runtime copy, preserving the existing application data. The user authorized reuse of the existing OpenAI key; it was stored encrypted through the production credential repository and was not displayed or copied into a new key file. The loopback browser chat preview now renders at localhost:3000/chat. The first real user-interface test returned 503 before inference: the chat preflight incorrectly requires the bootstrap OpenRouter environment key even when a saved OpenAI connection and OpenAI model roles are configured. A product fix is being staged; real answering and iPhone readiness remain unverified.

Canonical finding counts remain unchanged. The 168-page Word artifact retains its earlier `340df1a` checkpoint. Current evidence receipts are `20261008-hc01-web-mounted-v5-terminal.json`, `20261008-hc01-preview-focused-v1-terminal.json`, and `20261008-hc01-preview-v2-static-build-terminal.json` under /tmp/assistant-playbook-review.


### Live test follow-up, 2026-10-08

The reviewed OpenAI structured-object compatibility policy is installed: direct OpenAI object requests disable provider strict-schema enforcement while retaining local Zod parsing, defaults and validation. The actual SDK wire regressions and focused suite passed **402/402 tests across 79 suites, with no skips or failures**, and all five static/build checks passed at unchanged runtime/config/test source `a5d8368f09d9eb86761cf13c5f1ba9c8d55d341b89761a0a6cb20b481b0b189a` (3,667 files). These checks are local qualification, not a full-suite or production acceptance certificate.

The private testing runtime was refreshed to that same source and its owned agent, loopback web preview and authenticated phone server were restarted. A real browser request completed task `8fd7cfb9-691c-49d0-8b03-11bf9301ee45` as `done`, with no retry and recorded cost $0.001610. The visible answer was “This local chat is working.” The browser displayed it twice even though authoritative persistence contained one assistant row. The duplicate display remains an open client reconciliation defect; the test checkpoint is not yet marked ready. Exact evidence is retained in the ignored `testing-checkpoint-v1/browser-live-checkpoint-v2.json` receipt.

After the owner closed the phone app, the reviewed signed build installed in place and foreground launch passed without resetting app data. The device procedure’s terminal receipt records `install_state: passed`, `launch_exit_code: 0` and `install_launch_performed: true`; its original top-level `state` remains `install_started`. Actual phone connection, chat interaction and accessibility checks remain pending. The dedicated phone server still returns 401 without its bearer and 200 with one, with auth bypass disabled; these are Mac-origin API checks, not proof of phone connectivity. The owner has local connection instructions containing only the dedicated test-server token.

Original requirement counts and acceptance conditions remain unchanged. No merge, push, production deployment, Firestore activation or database retirement occurred.


## Production flight-answer investigation and parallel follow-up

Owner testing was confirmed to use the existing production backend, not the dedicated local test server. Read-only service and durable-tool traces identified a future-flight lookup incorrectly narrowed by email received age, plus a successful calendar correction followed by stale pre-update answer grounding. The booking body independently confirmed the owner-reported departure time and a connecting itinerary; the calendar label also disagreed with the booking. This investigation did not write production data. A replay of the historical unsupported calendar creation through the current local workspace-write grounding function was rejected before dispatch; this is a pure function check, not production acceptance.

Flight lookup/date grounding, canonical calendar update receipts and conservative proactive flight-lead suppression are staged outside the checkout pending root review and qualification. A separate composed stable-operation retry regression is being prepared; native cancellation runtime verification is continuing on dedicated disposable simulators. The current local browser duplicate-reply repair was independently retested through the actual preview UI: the new reply appeared once. Physical installation and owner-reported production chat are established; dedicated local phone acceptance and native cancellation XCTest execution are separate gates.

The preceding 458-method focused qualification and all five static/build checks passed at runtime/config/test source `3b29f404836b6b68dba6721427162c81ac310a1e54844bd4d7f37948059e9381` (3,667 files). These precede the new flight candidates and do not qualify them. Original requirement counts and acceptance conditions remain unchanged; no production deployment or full-playbook completion is claimed.


### Integrated flight and admission checkpoint, 2026-10-08

Five reviewed packets and the flight-correction addendum are now installed locally: booking-date/received-age flight retrieval, deterministic booking departure or coverage/conflict answers, canonical calendar update receipts, conservative flight salience and response cards, strict goal-form calendar dates, and actual application admission retry composition on PostgreSQL and Firestore. A successful current-task flight update receipt takes precedence even when the owner correction omits an explicit update verb. An unrelated calendar update does not satisfy missing flight-read coverage. Raw calendar cards do not reintroduce an unsupported flight time. These are scoped behaviors; complete itinerary ingestion, all flight aliases and live provider retrieval acceptance remain open.

The canonical 14-file focused run passed **592/592 methods across 63 suites, with zero skips/failures**, at unchanged runtime/config/test source `bb97d51f040dbaa002453223fad2ee477247996a1e1935ff037f99ac18a3398f` (3,670 files). All five static/build checks passed at that same source: forced package typecheck, scripts typecheck, lint, diff check and production build with auth bypass disabled and the prior local environment restored. Disposable test databases were cleaned. The first two integrated runs exposed test-import, encoded Firestore document-ID and new-fixture leakage problems; their failed receipts remain intact. The final run uses the durable task ID and cleans only the new flight fixture mail, bookings and booking-derived suggestions.

Offline reconstruction of the production incident rejects a confident 09:15 answer when the original queried results omit the booking. A controlled reconstruction with the already-recorded dated booking returns its 1:45 PM departure without inventing a United carrier or direct route, or substituting arrival/onward-leg clocks. The reconstruction adapts archived broad query metadata and calendar windows explicitly; it is not live provider retrieval or a mounted phone test. Historical unsupported flight creation remains rejected by the current local write guard.

A disjoint offline `apps/agent` shard is running at the same frozen source. HC-05 contact-before-clarification and overlapping-request controls are separate staged follow-ups. Native cancellation XCTest attempts have not executed the 12 selected tests because the dedicated simulator runner could not start; native build success is not a test pass. Production `bot.bmson.com` remains unchanged by this work. Dedicated local phone acceptance, merge/deploy and full-playbook acceptance remain open. The 246 canonical finding statuses and the earlier Word artifact are unchanged.

Receipts under `/tmp/assistant-playbook-review`: `20261008-flight-grounding-proactive-focused-v3-terminal.json`, `20261008-flight-grounding-proactive-v3-static-build-terminal.json`, and the explicitly limited `flight-time-grounding-stage-v6-addendum/offline-incident-replay-report.json`.


### Composed chat identity follow-up, 2026-10-08

The broader `apps/agent` attempt was stopped after reproducing an obsolete synthetic model fixture: the admission preflight called `ModelRouter.route`, which those test doubles lacked, so they returned 503 before the tested journeys. Its partial log and exit-143 receipt are preserved; no full-shard aggregate is claimed. All five newly allocated parent/child PostgreSQL databases were independently cleaned only after verifying their exact ownership sentinels and absence of active clients; all pre-existing allocator targets were preserved.

The fixture repair supplies the successful offline route contract without changing production preflight or weakening assertions. The selected four-file composed run then passed **73/73 methods, 10/10 suites and zero skips/failures**, with all five static/build checks passing at unchanged source `2e5a9351cc27c2beafbcec194a00e0f4c1c860c6ce83c8bc36307237f0817c68` (3,670 files). It includes two queued owner operations, B completing while A is delayed after its persisted calendar result, A completing afterward, and B retaining the exact durable message ID/text. Queued worker results are bound by task ID and durable message ID; their nullable channel field is not treated as a streamed conversational reply identity. Both intentional same-text sends and stable lost-response replay remain covered.

A subsequent actual Firestore emulator test passed **1/1 with zero skips** at unchanged source `cfe553f13be0cbfb059fd731bd35ed5304c2a22dedc63ad4f9cde2b3b575e28f` (3,671 files), composing application admission, Firestore chat/execution repositories, task executor and dispatcher for the same delayed A/B interleaving. The calendar and model ports are synthetic; production queue transport and mounted browser ordering are not certified by this test. The PostgreSQL fixture databases were cleaned and the unique Firestore installation was disposed.

The production runtime/config code remains byte-identical to the prior qualified flight checkpoint; only three composed test files and then one new Firestore test were changed. The private preview remains on that flight checkpoint. HC-05 is still staged for root review and composed verification. These receipts do not close the full P02/P03 packets or the 246-finding playbook. No production merge, push or deployment occurred.

Evidence under `/tmp/assistant-playbook-review`: `20261008-chat-composed-p02-focused-v2-terminal.json`, `20261008-chat-composed-p02-v2-static-build-terminal.json`, `chat-composed-p02-production-runtime-continuity-v2.json`, `20261008-p02-firestore-operation-focused-v1-terminal.json`, and `20261008-agent-shard-bb97-v1-cleanup-followup.json`.


### Contact lookup and fresh-request qualification, 2026-10-08

HC-05 contact-before-clarification is installed locally with bounded saved-contact retrieval, honest empty/unavailable-source questions, an explicit ambiguity question, and one persisted planner retry after a unique saved address. A verified address does not invent missing email content or claim an email was sent. Explicit contact-search opt-outs leave the recipient unresolved. The actual PostgreSQL and Firestore composed controls use the portable contact tool and inspect execution evidence; no Gmail send occurs in these clarification cases.

The composed controls exposed a real continuation defect: after asking for Anna's address, a fresh complete request for Jordan inherited Anna's request. The narrowly reviewed repair recognizes complete fresh email requests after recipient clarification, including the observed saved-contact ambiguity prompt and colon-delimited content. Short address/name answers and email-body answers still continue their recorded clarification. The same-conversation regression now asserts the exact contact-query sequence Anna, Beth, Jordan, Casey. A second routing defect treated an explicit email command with “do not search contacts” as a Gmail-read request; leading email/e-mail commands now retain workflow planning. These changes do not qualify general semantic conversation understanding or close all P02/P03 conditions.

The 20-file combined flight, proactive, goal-date, contact and composed chat qualification passed **734/734 methods across 83/83 suites with zero skips or failures** at unchanged runtime/config/test source `20f8c01c0c1b3e3d66c5d11e543efae9a985145d280463d4bbf248eb877908a0` (3,671 files). All five static/build checks passed at the same source, with the local environment restored and no new allocator databases left. Failed earlier composed attempts and the isolation diagnostics remain preserved. The scoped copied candidate's unresolved dependency typecheck is superseded by this successful full package typecheck, not rewritten as a pass.

The separate P03 explicit source-read prohibition candidate remains uninstalled. Independent review reproduced three defects in its first version: incidental “meeting” in an email clause denied an allowed calendar read, an “and” companion read was denied, and Google Docs lacked the source prohibition. Its first ten copied controls are not acceptance of those failing cases. A revision is in progress. Production, physical-phone behavior, full-suite acceptance and the 246 canonical finding statuses remain unchanged.

Receipts under `/tmp/assistant-playbook-review`: `20261008-flight-chat-hc05-union-focused-v3-terminal.json`, `20261008-flight-chat-hc05-union-v3-static-build-terminal.json`, `hc05-fresh-request-root-applied-v2/receipt.json`, `20261008-hc05-ambiguity-diagnostic-v1-terminal.json`, and `p03-explicit-read-prohibition-review-v1.md`.


### Explicit source-read fence qualification, 2026-10-08

A reviewed bounded source-read prohibition is installed at `ToolDispatcher`. Direct owner-authored prohibitions apply to the named confidential source before dispatch/replay and before approved private-read execution or result return. The parser uses already-separated owner text, so quoted third-party prohibitions do not constrain a direct owner request. Common Gmail, Calendar, Docs, Drive, Sheets and Contacts source words are mapped; other protected sources and full semantic negative-scope interpretation are not closed by this packet.

Independent review rejected the first three staged revisions after reproducing incorrect companion-source denials, missing Docs and plural recognition, and leading-preposition gaps. The fourth revision's copied 25-method suite and 19 selected prior-failure controls passed. It binds the prohibited direct object rather than an incidental later source mention, preserves explicitly allowed companion reads and coordinated denials, recognizes the tested plural forms, and covers “don't search in Gmail” and “do not look in my inbox.” Earlier failed review receipts and the transient candidate-copy custody correction remain preserved.

The 24-file combined flight, chat, contact and dispatcher qualification passed **835/835 methods across 93/93 suites with zero skips or failures** at unchanged runtime/config/test source `29c0faf4d0462cec401c716284fe1b936a560c0a31f579a1b49592ec8716953a` (3,672 files). All five static/build checks passed at that source; the local environment was restored and no new allocator databases remained. This includes the 25 direct-source controls, existing dispatcher/approval/cache behavior and the earlier contact/flight/chat checks. It is selected local qualification, not a full suite, full R7/P03 request-contract acceptance or deployed phone behavior. Deterministic pre-force routing and additional denial-specific cached-result controls remain follow-ups.

The private preview was refreshed to this qualified source; both local server health checks returned 200 and the unauthenticated phone bootstrap returned the expected 401. These are Mac-origin readiness checks, not physical-phone acceptance. Production `bot.bmson.com` remains unchanged. The full 246-finding register and earlier Word artifact remain at their recorded acceptance states; no merge, push or deployment is claimed.

Evidence under `/tmp/assistant-playbook-review`: `20261008-flight-chat-contact-read-union-focused-v4-terminal.json`, `20261008-flight-chat-contact-read-union-v4-static-build-terminal.json`, `p03-explicit-read-prohibition-root-applied-v4/receipt.json`, and `p03-explicit-read-prohibition-review-v4-acceptance.md`.


### Generic-document no-read composition, 2026-10-09

R7's common “Do not open this document” wording is now recognized at the Docs dispatcher boundary. The composed scripted executor case proposes `docs.get` anyway and proves zero document callbacks, zero document tool-call rows and a useful general URL explanation without claiming a temporarily unavailable read. The existing ordinary owner-shared Google Doc positive control still succeeds. The fixture now supplies real classify/plan response shapes and counts those roles separately.

The selected negative/positive executor and dispatcher run passed 29 selected methods; 22 unrelated executor methods were filtered only in that narrow run. The following full 25-file combined qualification executed every method in the selected files, including all 24 executor cases: **861/861 methods, 95/95 suites, zero skips or failures**. All five static/build checks passed at unchanged runtime/config/test source `d762b3cd8c4bf6e707efd18e3ded71fbd0213b0e32881734190c8ec03c15d471` (3,672 files), the local environment was restored and no new allocator databases remained.

Full R7 acceptance remains open: the current source-level prohibition still blocks an explicitly allowed different document in the same tool family when one URL is prohibited. Independent copied controls reproduce that gap; a target-bound repair is being staged. The native accessibility-size composer proposal is also uninstalled and awaits current-source compile/render qualification. The tracker now separates concrete implementation gaps, including durable email observer delivery, from implemented behavior awaiting acceptance. Neither the 246 canonical finding counts nor production deployment changed.

Evidence under `/tmp/assistant-playbook-review`: `20261009-r7-generic-document-focused-v1-terminal.json`, `20261009-r7-flight-chat-read-union-focused-v1-terminal.json`, `20261009-r7-flight-chat-read-union-v1-static-build-terminal.json`, `r7-generic-document-root-applied-v1/receipt.json`, and `r7-target-and-companion-review-v1.md`.


### Document target permissions and native composer readability, 2026-10-09

The R7 dispatcher now binds an explicit Docs URL prohibition to that document ID. A separate document is eligible only when the same owner-authored request directly asks to read its exact URL; unmentioned targets, explanatory wording, quoted instructions and compact receipts without resource arguments remain blocked. A source-wide no-read instruction still blocks the entire source. Approved replay checks the effective resolution payload before returning an existing result. Normal scope and policy checks still apply. The composed scripted executor regression proposes the denied document, receives the refusal, then reads only the explicitly permitted second document; persistence records only that allowed call.

The 25-file selected flight/chat/contact/read-permission union passed **875/875 tests across 95/95 suites with zero skips or failures**, with all five static/build checks passing at unchanged runtime/config/test source `40b0450c74ccd3602b64c0f41787e958422f8c0d9951ef6a3f69bdbc14154409` (3,672 files). A separate two-file regression passed all 65 selected methods with no skips. The allocator catalog had no new leftover databases and the web local environment was restored. Receipts: [combined tests](/tmp/assistant-playbook-review/20261009-r7-target-binding-union-focused-v3-terminal.json), [static/build](/tmp/assistant-playbook-review/20261009-r7-target-binding-v3-static-build-terminal.json), [narrow composition](/tmp/assistant-playbook-review/20261009-r7-target-binding-composed-focused-v3-terminal.json). These are selected local checks; full R7/P03 and all original acceptance journeys remain open.

The iPhone composer now uses short visible state prompts at accessibility text sizes and retains the full prompt as its accessibility label. Root and the native reviewer inspected eight current/candidate idle renders at ordinary Large and Accessibility 5 in both themes: current A5 clips “Ask anything…” while candidate “Message” fits; ordinary-size wording is unchanged. Actual checkout app/test-target `build-for-testing` succeeded. No XCTest methods, VoiceOver interaction or physical-device checks ran. Exact render/build/source evidence is in the [native manifest](/tmp/assistant-playbook-review/native-composer-shadow-qual-v1/qualification-manifest-final.json).

The private browser/phone runtime was refreshed to this exact source. Both local health checks returned 200, and unauthenticated phone bootstrap returned 401. Fresh visible browser acceptance was not obtained: the computer-use surface reported the Mac locked and preview navigation timed out. Earlier live-chat evidence retains its earlier source and is not promoted to this revision. MC-04 durable email observer storage and module integration are being staged in parallel; its atomic admission, paid-result recovery, notification deduplication, independent rate budget and privacy acceptance remain unfinished. No rewrite changes were merged or deployed, and the 246 finding counts remain unchanged.


### Recorded-resource replay and card recovery checkpoint, 2026-10-09

The Docs permission check now examines the resource arguments stored on a recovered call, including effective approval arguments, rather than relying on the newly proposed input. Model-call replay, idempotency recovery and a concurrent reconciliation result cannot return a denied document merely because a different document was requested. Missing resource arguments on compact receipts remain blocked. Independent copied old-code controls reproduced five leaks; the reviewed repair is installed locally. The focused composed executor/dispatcher run passed 78/78 tests at its recorded prior source.

Generated-card composition now exposes validated card, deterministic no-op, no-provider-work budget block and unknown outcomes. Existing callers retain the nullable interface. The object router preserves evidence of a dispatched primary attempt when the fallback is blocked by budget. Two old-code controls reproduced the evidence loss; corrected real-router controls distinguish those failures from an initial budget denial that dispatches no provider. This is groundwork for email recovery, not installation of the durable email worker.

The recorded 27-file selected regression passed **952/952 tests across 107/107 suites, zero skips/failures**, and all five static/build checks passed at unchanged runtime/config/test source `5de783942b2cc1215c6ec2b9b1f54ffb02e261a494fbb0dc05163833d0aeb89c` (3,672 files). The allocator left no new test databases, the production build disabled auth bypass and the local environment was restored. Exact evidence: [combined tests](/tmp/assistant-playbook-review/20261009-card-router-r7-union-focused-v1-terminal.json), [static/build checks](/tmp/assistant-playbook-review/20261009-card-router-r7-v1-static-build-terminal.json), [guarded card/router installation](/tmp/assistant-playbook-review/mc04-card-router-root-applied-v1/receipt.json). This is selected local qualification; it does not close the original full acceptance register.

The private browser/phone servers were refreshed to this source. Mac-origin health checks returned 200 and unauthenticated phone bootstrap returned 401. An authenticated local mobile bootstrap and chat request both returned 200; the real model streamed “Hello!” with no error events at this exact source. The [mobile API receipt](/Users/baldvinsmarason/Code/Personal/assistant/.workspace/playbook-review/testing-checkpoint-v1/mobile-api-live-v10.json) records the isolated local path and contains no access key. Fresh visible browser and physical-phone acceptance remain open. The native composer retains its previously recorded eight idle renders and compile evidence only. MC-04 atomic email admission, observer recovery, transactionally guarded effects, notification deduplication, independent budgets and erasure are still staged. Review identified prepared-lease contention and stale-clock risks that require adapter tests, and source re-reading alone cannot prevent a late downstream write after erasure. The 246 original finding statuses are unchanged. No rewrite merge, push or production deployment occurred.

Independent review of the staged email adapters reproduced two defects using the real Firestore SDK: erasing a legacy ingest failed on an absent classification field, and a card write could change a prepared departure value while retaining its IDs. A separate coherent copy of the corrected staged adapters then passed **12/12 actual-emulator tests in five files**, with zero failures/skips and unchanged copied source pins. The run covers those controls, stale conversation admission with zero writes, card token/lease/privacy rejection, observer contention, frozen empty-registry replay, concurrent paid reservations and prepared-result recovery. [Exact staged receipt](/tmp/assistant-playbook-review/mc04-root-emulator-v2-snapshot-v1/runs/snapshot-qualification/terminal.json). This receipt qualifies its copied adapter snapshot only; the final foundation, composed email module, PostgreSQL transition timing, notification effects and worker activation still require qualification. Its tests are not added to the installed-source total above.

Subsequent qualification pinned the final 22-file foundation and passed **14/14 actual-emulator tests**, including the no-provider budget refund and UTC-day retry controls. Its PostgreSQL repository suite passed **17/17**, including a completion held behind a row lock until its lease expired. These receipts strengthen the staged foundation evidence; they do not change the installed-source total. [Final foundation emulator receipt](/tmp/assistant-playbook-review/mc04-final-foundation-emulator-qualification-v1/runs/final-foundation/terminal.json).

The next staged integration includes immutable direct-email routing, bounded discovery of interrupted intake, notification delivery fences and writing-sample effect fences. Notification tests uncovered a Firestore erasure defect: the cleanup compared an encoded document ID with a logical producer ID, leaving a derived dashboard message behind. The corrected notice candidate passed 21 selected PostgreSQL tests, four actual-emulator outbox tests and 19 module/validation tests. The recovery candidate separately passed 22 PostgreSQL tests and three actual-emulator recovery tests. These are separate candidate qualifications, not a combined acceptance result.

The writing-sample fence rejects stale claims, altered prepared embeddings, changed canonical source text and advanced erasure generations in the same transaction as saving. A deterministic UUID deduplicates Firestore retries without relying on its truncated text index. Five PostgreSQL tests and six actual-emulator tests passed, along with forced package typechecks, at unchanged copied source. A paired old-code control reproduced a sample save under a stale token. Review also found that a legitimate initial null privacy generation was rejected by the staged module; its successor now accepts that initial state and tests the durable observer drain. [Writing-sample qualification](/tmp/assistant-playbook-review/mc04-voice-effect-fence-stage-v3/qualification.json).

Account-erasure review found that the real `repository.erase()` lifecycle did not invoke the standalone observer cleanup, despite passing helper tests. A separate four-file repair moves notice-derived message and channel-map deletion into that actual lifecycle. Its PostgreSQL lifecycle tests passed 4/4 and its focused actual-emulator lifecycle case passed 1/1 (eight filtered). The combined rerun then passed 185/188 tests with zero skips; three recovery fixtures still lacked the actual observer registry or represented an interrupted classification with a prepared result. Those fixtures were corrected without removing their replay, provenance or no-provider assertions. A subsequent PostgreSQL/non-Firestore run passed 152 tests, with 14 actual-Firestore cases explicitly skipped while another review owned the emulator. Forced package typechecks passed. The staged compatibility declaration now requires PostgreSQL schema 122 for the new agent/web build, and the regenerated support matrix and full lint checks pass. These are staged qualifications, not production evidence. [Combined rerun](/tmp/assistant-playbook-review/mc04-composed-qualification-stage-v1/runs/composed-v8-regression-second/terminal.json), [fixture rerun](/tmp/assistant-playbook-review/mc04-composed-qualification-stage-v1/runs/composed-v8-regression-third/terminal.json), [compatibility and lint](/tmp/assistant-playbook-review/mc04-composed-qualification-stage-v1/runs/composed-v8-lint-fourth/terminal.json).

The subsequent erasure successor passed three focused actual-emulator controls, including cleanup resumed after work scrubbing, deletion of a channel map whose raw message is absent, preservation of unrelated-owner records and admission of a fresh writing sample with both independent privacy tokens after completed erasure. Its four paths were composed by exact preimage guards. Integration also exposed a valid short-email rejection: the stored provenance validator incorrectly compared the display-header length with the separate body length. A paired control using the actual core producer reproduced the old rejection and confirmed the correction. The adapters now compare unchanged provenance structurally rather than by JSON key order, and intake freezes routing and provenance before paid claims. Durable-source replay also preserves its frozen observer route instead of entering legacy task repair. The selected PostgreSQL/non-Firestore group passed **155 tests, zero failures, with 15 actual-Firestore cases explicitly skipped**, and script typecheck, lint and the auth-bypass-disabled build passed at unchanged copied source `f75d83bdeb808bfa8ed14a23c624740df6c085508850ad0358a1ebad821e5bcc` (3,687 files). All-package typecheck passed at the preceding source before the final replay-fixture update. [Current copied tests](/tmp/assistant-playbook-review/mc04-composed-qualification-stage-v1/runs/composed-v8-regression-seventh/terminal.json), [copied build](/tmp/assistant-playbook-review/mc04-composed-qualification-stage-v1/runs/composed-v8-build-seventh/terminal.json), [short-email old-code control](/tmp/assistant-playbook-review/mc04-composed-qualification-stage-v1/provenance-contract-repair-v2/oldcode-control/receipt.json).

The combined successor passed **201/201 selected tests across 64 suites, zero failures/skips**, including the actual Firestore emulator, at copied source `a8bdbb39a837df9850f18b8835e1a56612600bd721e96983c9084cd0bd8a3356` (3,689 files). Forced all-package typecheck, script typecheck, lint, the auth-bypass-disabled build and the changed-file whitespace check all pass at that same source. The [pinned combined manifest](/tmp/assistant-playbook-review/mc04-composed-qualification-stage-v1/combined-a8-qualified-snapshot-v1/manifest.json) records 78 changed source paths against the installed source at the time of qualification. These results supersede the preceding bounded candidate qualification; they are not the full playbook acceptance suite.

The combined actual-ingress tests caught a task-creation defect that the isolated task-fence fixture had mirrored: the Firestore implementation encoded logical IDs before passing them to a store that already encoded them. Thirteen Firestore cases failed. The root correction supplies logical IDs to the store and fixes the fixture to exercise the real layout; all 201 combined tests then pass. The [layout repair receipt](/tmp/assistant-playbook-review/mc04-composed-qualification-stage-v1/task-fence-firestore-layout-repair-v1/receipt.json) preserves the preimages and correction. The earlier isolated positive is not treated as proof of actual-ingress behavior.

Application-confirmation review found another boundary gap: matching a supplied token hash to a watch and a supplied digest to an email did not independently prove that the selected watch's token appeared in that email's sender-authored content. The corrected claim successor validates membership against the canonical saved source and rejects absent or quoted-only watch tokens. Composed with the recovery, task, erasure and writing-sample changes plus the layout repair below, it passes **216/216 selected tests across 73 suites in 30 files, zero failures/skips**, including actual PostgreSQL and Firestore runs. All five static/build checks pass at unchanged copied source `5c3fc6aba497417e4ad7033b56253db1e741281e672e22ab16a1b482ae2a3831` (3,692 files). The [successor manifest](/tmp/assistant-playbook-review/mc04-composed-qualification-stage-v1/combined-claim-v2-qualified-snapshot-v1/manifest.json) pins 85 changed source paths against the primary checkout after its single CSS repair. Atomic application claim/task handoff remains separate, and review also identified whole-body token matching and rejected-claim replay reporting in the module as unresolved behavior. Attachment work is separately staging conditional-generation storage custody, durable upload intent and erasure cleanup; passing storage primitive tests alone does not close that lifecycle.

Fresh mounted browser inspection subsequently found that the route transition wrapper expanded to 992 px inside a 619 px chat area, placing recent replies outside the clipped screen. A narrowly scoped CSS repair makes that wrapper share the remaining flex height and keeps the main column at its intended width. It is installed locally after checks at 1280, 640 and 390 px widths, a four-line phone-width composer check, targeted lint and whitespace validation. The newest reply clears the composer and there is no horizontal page overflow at those checked sizes. [Installation receipt](/tmp/assistant-playbook-review/chat-viewport-route-container-stage-v1/installation-receipt.json). This supersedes the earlier locked-browser blocker for these specific mounted layout checks; physical iPhone keyboard/safe-area behavior and full browser acceptance remain open. The previous 952-test receipt remains tied to its previous source, before this single CSS change.

The private browser subsequently completed a live synthetic chat turn: one submitted prompt, one returned “Browser chat ready.” reply, an empty composer and no remaining Stop control. The reply clears the composer in the mounted layout. The [browser receipt](/tmp/assistant-playbook-review/chat-viewport-route-container-stage-v1/live-browser-chat-receipt.json) and [screenshot](/tmp/assistant-playbook-review/chat-viewport-route-container-stage-v1/chat-live-browser-after.jpg) record this local check at installed source `29a6919015e88fda311b6d754c1215bd04062c416c3699e082bb8f364e52e00d` (3,672 files). The browser uses the explicit localhost development bypass; this does not change the authenticated phone listener or establish production behavior.

A separate synthetic mounted-card check uses the exact installed `ResponseCards` component bytes. Hidden booking values are absent from visible text and accessible attributes; private image fields create no image element, and the sensitive progress total is masked with progress reported as unknown. Explicit reveal exposes the booking value through its button and status roles. Replacing that value under the same fact ID/revision update masks it again and clears the status text. The [mounted privacy receipt](/tmp/assistant-playbook-review/web16-mounted-privacy-stage-v1/browser-receipt.json) records the temporary private-preview harness and its limits: no network capture, physical VoiceOver or iPhone accessibility proof is claimed. WEB-16 and IOS-11 remain Partial.

Root review of the separate atomic application handoff found that the observer lease could expire while a watch lock or task operation was pending. Two new controls failed against the original code while the preceding 15 checks passed; the old implementations committed an expired handoff. The repair checks a fresh clock after the transactional task operation and throws to roll back the watch/task together. PostgreSQL uses its database clock while retaining the owner/work locks; Firestore reuses its locked reads and avoids reads after queued writes. Composition also preserves the attachment schema/module additions, updates the existing nullable file fixtures and exercises actual core-authored provenance with the atomic handoff port. The combined copied successor passes **276/276 selected tests across 83 suites in 33 actual files, zero failures/skips**, plus all-package typecheck, script typecheck, lint, the auth-bypass-disabled build and changed-file whitespace checks at unchanged source `add24298afca3eb082c2ee92095f0bc0550aeefb629210b8cc33b3c96c4f71ec` (3,697 files). The [qualified successor manifest](/tmp/assistant-playbook-review/mc04-application-handoff-late-clock-stage-v1/atomic-late-clock-qualified-snapshot-v1/manifest.json) archives 97 changed source paths against installed `29a69190`. Its journal preserves migrations 0123 and 0124 and its copied agent/web release contract requires PostgreSQL schema 124. This qualification does not cover attachment adapters or enable the recovery worker.

A further ordinary-email task control held an insert behind an uncommitted unique-index conflict until its observer lease expired. The prior implementation created a task after that wait; the separate successor validates the fence again after the insert and rolls the transaction back. Its copied PostgreSQL/module/core group passes **42/42 selected tests across 13 suites in six actual files, zero failures/skips**, plus all-package typecheck and changed-file lint/whitespace checks at unchanged source `8c1556981f6489b180d4240dccca98b8fd398a19eadd521ff1940fc0722f84ea` (3,697 files). The [two-file successor manifest](/tmp/assistant-playbook-review/mc04-task-postinsert-clock-stage-v1/qualified-postinsert-patch-v1/manifest.json) preserves the failed old-code control. No full combined Firestore regression or production build is claimed at this newer source; the 276-test/build qualification above remains tied to `add24298`.

The separately frozen PostgreSQL attachment successor passes **24/24 tests in three focused files**, DB typecheck and changed-file lint. It validates the frozen observer registry and canonical source, commits custody erasure in 32-row pages, preserves an active owner fence across interruption and cleanup, and acknowledges late cleanup for an older marker without clearing a newer generation. Its [four-file incremental manifest](/tmp/assistant-playbook-review/mc04-postgres-attachment-custody-stage-v2/manifest-v2.json) preserves the separate source pins. Root review then identified a remaining recovery-worker gap: its cleanup listing lost the exact pending generation, and the PostgreSQL acknowledgement recreated rather than drained that intent. A subsequent shared-port/worker repair is in progress; this focused result does not establish the full producer/consumer lifecycle.

An isolated metadata check adds the schema declaration for the constraint already present in migration 0124 and a snapshot chained from 0123. Offline generation reports no subsequent schema changes. The [metadata manifest](/tmp/assistant-playbook-review/mc04-schema124-metadata-stage-v1/manifest.json) is separate from the qualified runtime candidates and has no database/build qualification of its own.

These persistence, notice, recovery, task and writing-sample changes remain outside the primary checkout. Atomic application claim/task handoff now has the bounded copied qualification above; later owner notices and Sheets/Docs effects still need lifecycle acceptance. Attachment custody, the recovery consumer, enabled-worker behavior, full browser/iPhone acceptance and release remain open. The original 246 finding statuses remain unchanged; no merge, push, deployment or external notification is claimed.


### Attachment lifecycle composition checkpoint, 2026-10-09

The Firestore attachment successor is frozen separately: its focused producer, duplicate replay, actual owner-erasure and exact-generation storage tests pass **39/39** with unchanged source before and after. The [32-file manifest](/tmp/assistant-playbook-review/mc04-email-attachment-firestore-lifecycle-stage-v6/manifest-v6.json) records real emulator calls and no live provider or GCS calls. Root composed those files into the isolated attachment candidate while preserving the newer atomic handoff, post-insert fence and migration metadata. Review resolved the queue-notifier import and removed a duplicated shared extractor export introduced by composition.

The resulting selected shared/core/application/storage group passes **55/55 tests across 14 suites in five actual files, zero failures/skips**, at unchanged copied source `99b92ecb1701dff7f2f3769a624cee4d012112d7b0b87d60c8c813e6eab2af7a` (3,707 files). [Scoped combined receipt](/tmp/assistant-playbook-review/mc04-attachment-lifecycle-composed-stage-v1/runs/native-v6-shared-tests-v1/terminal.json). The earlier combined typecheck failed on the duplicated export and the older PostgreSQL cleanup-list return type; the export is repaired, and the PostgreSQL successor remains in progress. These focused results are not full candidate qualification or installation.

Root also generated migration 0125 metadata after 0124 without discarding either prior migration. Offline comparison reports no additional schema changes. Four Node release-manifest controls and three Vitest support-matrix controls pass at their separately pinned preceding source `f53a87be058dc63da5c32cb23922646c506b3b6c09747a218b64fedca3ca1fd3` (3,703 files); that allocator run actually applied the new migration. [Metadata packet](/tmp/assistant-playbook-review/mc04-schema125-metadata-stage-v1/manifest.json), [manifest controls](/tmp/assistant-playbook-review/mc04-attachment-lifecycle-composed-stage-v1/runs/schema125-manifest-tests-v2/terminal.json), [matrix controls](/tmp/assistant-playbook-review/mc04-attachment-lifecycle-composed-stage-v1/runs/schema125-matrix-tests-v2/terminal.json). The initial incorrect test-runner attempt is retained as a failure. No build qualification at either newer source is claimed.

Actual normal-document deletion still needs correction and producer/consumer acceptance on both adapters. Root review found that the PostgreSQL fallback queued the custody file as a generic path; the new branch must retain exact marker/content cleanup intents instead. The Firestore review also needs to prove both known generations drain through actual document cleanup with matching document linkage. Both remain isolated work. The installed runtime, 246 finding statuses and production remain unchanged by this checkpoint.

The additional PostgreSQL/module/shared regression then passed **232/232 selected tests across 71 suites in 26 actual files, zero failures/skips**, at unchanged isolated source `001a144291f090c5fcff2d0012e7ff044373d82fe84ac5c7904f1d767da3dcb8` (3,708 files). [Selected combined receipt](/tmp/assistant-playbook-review/mc04-attachment-lifecycle-composed-stage-v1/runs/attachment-nonfirestore-regression-v1/terminal.json). This does not include the pending PostgreSQL v3 deletion/producer successor or the actual Firestore group. Full lint passed at the immediately preceding `73853487` source; no all-package/build pass is claimed for this later source.

Five index declarations were added only to the copied deployment specification. The expired observer-claim query combines owner/status equality with a lease-expiry range and needs a composite index; the four equality-only cleanup/task declarations provide explicit planning coverage rather than proving automatic index merging would fail. Three contract tests pass at `001a1442`; root moved the test into the existing scripts project after preserving the first uncollected, zero-test attempt. [Index packet](/tmp/assistant-playbook-review/mc04-email-observer-indexes-stage-v1/manifest.json), [root contract receipt](/tmp/assistant-playbook-review/mc04-attachment-lifecycle-composed-stage-v1/runs/observer-index-contract-v2/terminal.json). No live index readiness or index deployment is claimed. Index behavior was checked against [Firestore index documentation](https://firebase.google.com/docs/firestore/query-data/index-overview).

Further review found that the public GCS custody metadata wrapper dropped its optional generation argument even though its private implementation handled exact versions. That repair, historical-version regression, both-generation document cleanup and foreign-owner deletion controls are being qualified in separate successors. The [next activation review](/tmp/assistant-playbook-review/mc04-next-activation-review-v1.md) also records the still-missing runtime observer consumer and the downstream Sheets/Docs effect and final-notice erasure boundaries. These are concrete implementation gaps, not completed acceptance.


### Attachment producer and deletion qualification, 2026-10-09

The combined copied attachment candidate passes **336/336 selected tests across 104 suites and 43 actual files, zero failures/skips**, including actual PostgreSQL and Firestore calls, at unchanged source `c63666ffe87d633d852266c9797b0df4f863ca696a38857fd9e57e9556821025` (3,709 files). Forced all-package typecheck, script typecheck, full lint, the auth-bypass-disabled production build and changed-source whitespace check also pass at this same source. The [qualified snapshot manifest](/tmp/assistant-playbook-review/mc04-attachment-lifecycle-composed-stage-v1/attachment-c636-qualified-snapshot-v1/manifest.json) freezes **122 changed source paths** against installed `29a69190`. The prior 102-path whitespace helper omitted 20 inherited new foundation files; its passing result is incomplete patch coverage. The corrected v3 check includes all 122, preserves the old receipts, verifies every installed baseline hash and performs read-only application checking.

This composition includes actual normal-document deletion with both known attachment generations, exact-generation cleanup acknowledgement, late receipt quarantine after erasure, canonical-source/registry validation, duplicate catalog preservation and the public GCS metadata-generation wrapper repair. The PostgreSQL producer's lost-response replay check also runs inside the combined group. Object storage and Gmail ports are synthetic; this does not establish live provider, Cloud Storage or index deployment behavior. The preceding 335-test copy had two lint formatter failures; the repaired c636 qualification supersedes that incomplete combined result.

A separate test-only addition then passes **3/3 actual PostgreSQL producer boundary tests**, zero failures/skips, at unchanged copied source `09c9afa976d0e63eae41c175c4eebdbb50534409d2a198948dc8df50682e636a` (3,710 files). It proves that erasure completing while a content upload response is paused rejects the late receipt, publishes no file/document/task and retains exact marker/content cleanup intents; unsupported local storage rejects before Gmail or storage access; and replay of a cleaned duplicate preserves the existing owned Drive file/document without another object write or task. [Root composed producer controls](/tmp/assistant-playbook-review/mc04-attachment-lifecycle-composed-stage-v1/runs/producer-boundaries-composed-v1/terminal.json). Production code is byte-identical to c636; the newer source adds one test file, so its three methods are not silently added to c636's 336 total.

The portable background observer sweep and stable application-task notice generation fence are being implemented in separate copies. The observer rollout remains disabled, and new durable intake currently defers its observer effects while disabled; the foundation is not installed as a ready pipeline. The remaining Sheet/Doc effect gate must serialize final local acceptance against the owner generation and retain an honest nonretryable unknown receipt for uncertain remote outcomes. Memory erasure does not imply a blanket owner-authorized workflow wipe. Original finding counts remain unchanged: 232 Partial, 10 Implemented and locally verified, two Open, one Proposal and one Withdrawn. No backend installation, worker activation, merge, push or production deployment occurred.


A disjoint copied regression of 25 earlier grounded-answer, source-permission, contact/chat, calendar, proactive-card and model-contract files passes **909 tests with zero failures and 37 explicitly skipped embedded Firestore cases** at `09c9afa9` (3,710 files). [Prior feature regression receipt](/tmp/assistant-playbook-review/mc04-attachment-lifecycle-composed-stage-v1/runs/attachment-prior-feature-regression-v1/terminal.json). Two separate Firestore files were excluded from that selected run while the owned emulator was reserved for another adapter review. This is useful compatibility evidence, not a zero-skip/full-suite qualification, and is not combined with the differently pinned 336-test total.

Activation review also identified a durable-card feature-switch gap: the legacy callback respected `GENERATIVE_CARDS_ENABLED`, but the staged durable card handler did not check it before paid reservation/composition. The runtime successor must pause disabled work without losing its frozen identity or charging/composing, and must check live Gmail/rollout/readiness transitions during a drain. Prepared attachment replay must also respect the documents feature switch. These acceptance cases are added to the background-worker work; no worker is activated while they remain open.


A bounded native-toolchain repair attempt invoked Xcode's required first-launch setup. The verified owned process produced no output over 190 seconds and was stopped without operating on any simulator. The first-launch status remains exit 69; zero native tests executed. [Native setup attempt receipt](/tmp/assistant-playbook-review/native-first-launch-repair-attempt-v1.json). This does not supersede earlier compile evidence or establish iPhone interaction/accessibility acceptance.


The background-worker agent reports a final **30/30** actual PostgreSQL/Firestore runtime-sweep group, including disabled-feature handling, dynamic pause boundaries, unused paid reservation release before composition and prepared-result reservation retention. Root review first caught an encoded SDK document ID being passed to the logical-ID Firestore adapter in the new fixture; the corrected agent run preserves the earlier failure separately. The file-scoped packet is not yet frozen/composed, so this is agent-reported source-specific evidence rather than root candidate qualification or activation. Root also rejected the permissive missing-card-flag predicate; the successor requires explicit `GENERATIVE_CARDS_ENABLED === true` and explicit rollout enablement.

The separate Google Sheet/Doc effect successor uses the existing durable action state to record an opaque, terminal unknown outcome before provider dispatch, with conditional settlement for that exact claim. Review requires canonical tool/action/idempotency identity, exact confirmation-source lineage, explicit producer-generation membership, an immutable task lease and a fresh clock after locks. Missing generations must not silently become null, and a provider timeout must not be classified as a definitive rejection merely because it has a 4xx status. These controls and actual registered Doc/replay tests are being implemented before composition. No new table, broad workflow erasure or automatic retry of uncertain remote writes is introduced by this scoped design.


### Background worker and external-write composition, 2026-10-09

The private candidate now includes the default-off worker and the nine-file application external-effect gate. Exact preimage guards prevented applying an agent packaging patch that also contained unrelated differences; a replacement scoped to the manifest’s nine paths was checked and copied. At unchanged candidate `913b396c6310eeac6f51105397123101e3f631ff0a77994ae7e9597240392298` (3,714 source files), the focused actual PostgreSQL/Firestore/tool group passed **22/22**, and all-package TypeScript, scripts TypeScript, full lint, the auth-bypass-disabled build and 134-path whitespace checks passed. The initial scripts command used a nonexistent configuration path; the corrected existing scripts configuration passed. [Focused tests](/tmp/assistant-playbook-review/mc04-attachment-lifecycle-composed-stage-v1/runs/effect-integrated-db-tools-fs-v2/terminal.json), [scoped composition receipt](/tmp/assistant-playbook-review/mc04-attachment-lifecycle-composed-stage-v1/effect-gate-composition-v2.json).

The broader 47-file group passed **360 tests and failed two, with zero skips**, at that same source. Both failures concern fixture assumptions that the seeded owner still has null privacy generation after preceding erasure tests; they remain recorded and the test setups are being repaired. This is not a passing combined qualification. A separately pinned module repair preserves the opaque effect receipt during action-outcome checkpoint updates and has been composed afterward; the real executor/dispatcher interrupted-replay journey remains under qualification. The final-notice seven-file incremental packet cannot be installed alone because its predecessor dependencies are absent from the composed candidate; a complete scoped dependency packet and the ambiguous-match successor remain active. [Combined failure receipt](/tmp/assistant-playbook-review/mc04-attachment-lifecycle-composed-stage-v1/runs/effect-runtime-combined-v1/terminal.json), [receipt-preservation packet](/tmp/assistant-playbook-review/mc04-application-effect-receipt-preservation-stage-v1/manifest-v1.json).

Installed local source remains `29a69190` / 3,672 files. No backend installation, worker activation, production deployment, merge or push is recorded. The 246 finding statuses are unchanged.


### Combined worker, effect and final-notice qualification, 2026-10-09

The complete 30-path final-notice dependency packet is now composed with the default-off worker, attachment custody/recovery, application effect gate and receipt-preservation repair. Review found and fixed two additional boundaries: legacy application tasks without an explicit producer-generation field now stop before effects or result notices, and uncertain Sheet/Doc results carry the existing receipt classifier’s `effectStatus: unknown` and `retrySuppressed` markers. Internal successful tool results expose only application ID, action and status. This minimizes output; it does not expand memory erasure to retained application business records or ordinary tool-call history. The migration journal, snapshot and release contracts are aligned to schema 126.

The final copied source `d96d9fce1c304e64665a1361890f0942910d7d3ea6baa4d1e2e53c06d528115e` (3,719 files) passes **378/378 selected tests across 117 suites and 49 files, zero failures/skips**, including actual PostgreSQL and the owned Firestore emulator. Package plus agent TypeScript, scripts TypeScript, full lint, the auth-bypass-disabled build and complete 143-path whitespace guard all pass at this same source; the separate Node release-contract tests also pass. The [frozen 143-path manifest](/tmp/assistant-playbook-review/mc04-attachment-lifecycle-composed-stage-v1/notice-effect-worker-d96-qualified-snapshot-v1/manifest.json) has SHA-256 `da03ec9681b96718f38bceab0e6da364d1d856047cf328a7bb46f6ed833cc007`. It archives exact copied files, preimages, patch, source capture and terminal receipts. Earlier combined failures remain evidence: the 48-file runs had fixture assumptions about preexisting owner tasks, current generation and active-erasure cleanup; the fixture now checks new task IDs, scopes custody by its pre-erasure ID, preserves prior cursor rows, and acknowledges a marker only after a missing-generation receipt. Runtime privacy gates were not relaxed.

This remains a copied qualification, not backend installation, worker activation, merge, push or deployment. Broader prior chat/flight regressions are running separately; the atomic ambiguous-observer successor and original browser/iPhone/provider/recovery acceptance remain open. Canonical 246 finding statuses are unchanged.


The separate earlier-feature regression group subsequently passed **952/952 selected tests across 107 suites and 27 files, zero failures/skips**, including actual Firestore dispatcher/chat operation isolation, at the same `d96d9fce` source. The [prior-feature addendum](/tmp/assistant-playbook-review/mc04-attachment-lifecycle-composed-stage-v1/notice-effect-worker-d96-qualified-snapshot-v1/prior-feature-addendum-v1.json) archives that independent run without changing the frozen qualification manifest. These results cover selected chat/flight/read-permission/card behavior; they are not the complete original browser/iPhone/provider journeys. The ambiguous-observer packet remains separately under review.


### Combined ambiguous email successor qualification, 2026-10-09

The copied worker, attachment custody/recovery, external-effect gate and final task-notice pipeline now also includes atomic ambiguous-email attention handling. Both adapters independently recompute matches from the canonical authenticated sender-authored email under the current owner/work fence. They atomically commit the attention task and all corresponding notices, reject more than 100 matches, and validate exact replay identity and fresh lease/generation state. The module accepts the durable recheck decision and does not notify or enqueue when it returns `not_ambiguous`.

Root composition recovered one inherited module test omitted from the eight-path packet: the packet's mutable base contained that test while the qualified root predecessor did not. All nine paths were copied using exact before/after hashes and a scoped patch check. The frozen predecessor manifest and receipt remain unchanged; the [composition receipt](/tmp/assistant-playbook-review/mc04-attachment-lifecycle-composed-stage-v1/ambiguous-composition-v1.json) records the discrepancy.

The composed successor passes **388/388 selected tests across 117 suites and 49 files, zero failures/skips**, including actual PostgreSQL and the owned Firestore emulator. Forced package/agent TypeScript, script TypeScript, lint, the auth-bypass-disabled production build and the complete 144-path whitespace check passed at unchanged source `313d2654f2656215cb441dbc736014c7100305d398d154933a1b1ee870a993c0` (3,720 files); the separate Node release-contract check also passed. The [frozen qualification manifest](/tmp/assistant-playbook-review/mc04-attachment-lifecycle-composed-stage-v1/ambiguous-worker-313d-qualified-snapshot-v1/manifest.json) has SHA-256 `be0b162f3625af3d7a353bf1c1a22066ca8e8764eef0c60709bc474928a0f1d5`. An initial typecheck command named a nonexistent workspace package and failed before checking source; the corrected explicit forced command passed, and both receipts are retained. The build retains its previously documented unpdf import.meta warning.

The preceding 952-test group remains scoped to `d96d9fce`; no exact-source 952 rerun is claimed for this successor. Installed local source remains `29a69190`. No backend installation, worker activation, merge, push or deployment occurred. Full browser/iPhone interaction, authenticated provider-backed installation, restore/cutover and production acceptance remain open. The 246 finding statuses are unchanged. The user-facing tracker now separates the current checklist from its preserved historical evidence log.


### Observer rollout setting follow-up, 2026-10-09

Normal provisioning replaces the agent environment but previously omitted `EMAIL_OBSERVER_WORKER_ENABLED`, silently discarding an explicit rollout setting. The private successor now forwards the optional setting only to the agent service; unset retains the schema default false, explicit false remains off, and local documentation explains the coupled Gmail-sync/polling requirement. Root review caught swallowed shell errors in the first helper because command substitution clears Bash errexit. The corrected helper explicitly propagates the real env reader failure; the negative old-helper control is retained.

At copied source `df8dc2db583221d88397165cb34a881ea00107dfd1f9ea21000aa6af8ce70f2c` (3,722 files), shell syntax and the side-effect-free contract pass, as do all 5 deploy-environment tests and the complete 148-path whitespace check. The [scoped delta manifest](/tmp/assistant-playbook-review/mc04-attachment-lifecycle-composed-stage-v1/worker-rollout-df8-qualified-delta-v1/manifest.json) preserves these results. This five-path delta has no full 388-test/build rerun; those remain tied to `313d2654`. No cloud command, activation, installed-source change or deployment occurred.


### Combined rollout and authenticated-route qualification, 2026-10-09

The successor combines the rollout-setting delta with a new PostgreSQL HTTP-application integration test: actual `processMessage` admits the synthetic email; `createApp().request` reaches the actual shared-secret verifier and registered sweep. Absent and wrong secrets receive 401. With the Google client synthetically configured, Gmail sync enabled and the worker off, the authenticated request reports zero claims and leaves all admitted work fields unchanged. Root strengthened the packet assertions to reject a zero returned by a failed drain step and to compare complete rows rather than only pending status/null tokens. This is an in-memory application request, not a served browser journey. Enabled portable worker tests remain separate; no enabled-worker route comparison or Firestore route request is claimed. Credential-free maintenance records an unrelated embedding-backfill no-model-connection failure, so this check does not establish full maintenance health or live-provider readiness.

All **394/394 selected tests across 121 suites and 51 files pass, with zero failures/skips**, including real PostgreSQL and the owned Firestore emulator. All five package/agent TypeScript, script TypeScript, lint, auth-bypass-disabled production build and complete 149-path whitespace checks pass at unchanged copied source `a2e97b05bb330aa450a892eef5e48984a79d7595577c88ace43cab106cd30ffd` (3,723 files). The real shell environment contract, Bash syntax and separate Node release-contract checks also pass at that source. The [frozen combined manifest](/tmp/assistant-playbook-review/mc04-attachment-lifecycle-composed-stage-v1/rollout-route-a2e-qualified-snapshot-v1/manifest.json) has SHA-256 `7983ee242ba26c5ca0253012f8aa4c1b4c3226afea1e891485d289712adde323` and preserves all corresponding receipts and guarded changed files. The build retains the documented unpdf warning.

The prior 952-test group remains tied to `d96d9fce`; no rerun is claimed at the successor. Installed source remains `29a69190`; no backend installation, worker activation, merge, push, cloud action or deployment occurred. Mounted browser replay/Stop/read-permission journeys are still open and currently blocked by the locked Mac. Native checks await first-launch Xcode setup. The full original acceptance register and finding counts remain unchanged.


### Latest native iPhone installation, 2026-10-09

At the owner's explicit request, the current primary native tree was snapshotted (93 files; source manifest `297c0fdb6b00d805842156bb28dc0f97f13b90407435dd0d9b341ea0d46e1add`), built for the paired physical iPhone and installed over bundle `com.baldvinsmarason.assistant`. Build exit0, deep signature verification, exact signed app/extension identifiers and team, profile expiry and phone membership all passed. The extension has a legitimate team wildcard profile; the isolated procedural validator now requires it to authorize the exact independently verified signed extension identifier rather than requiring the profile string to equal that identifier. The original procedure and initial failed validation receipt remain preserved.

The device installation and foreground launch both report success, and launched PID3241 with the new installed bundle path was observed running afterward. The [installation receipt](/tmp/assistant-playbook-review/iphone-latest-app-install-20261009T140524Z/installation-receipt.json) pins source, signed bundle, device and process evidence. No uninstall, app-container reset or Keychain erasure was performed. The source remained equal to the current primary native tree. This does not establish physical chat/VoiceOver/keyboard behavior or native test-suite success; zero tests were executed in this installation task and first-launch Xcode status remains69. The backend rewrite remains staged and was not deployed by the phone update. Finding status counts are unchanged.
