# Composer preflight follow-up

## Genuine empty callback followed by binding rejection

Status: source-inferred existing behavior, compared with PR #662 baseline
`45af98c079af877dccbfd3050b9e4e91ce1c473e`. This ordering has not been
reproduced in a running app. It is separate from the pending-local-edit
teardown regression addressed by the submission provenance token.

Reproduction plan using synthetic text and the existing held-response fixture:

1. Establish an owner-bound AppModel and calendar coordinator with an empty
   composer. Submit a synthetic question and hold the calendar preflight GET.
2. After submission staging, deliver a genuine current empty composer change
   through `saveComposerDraftChange`. This is an accepted authoritative edit,
   distinct from an obsolete callback whose value differs from current UI text.
3. Release a well-formed calendar response identifying a different owner. The
   coordinator rejects its binding while AppModel retains its draft session.
4. Assert no chat POST occurs and inspect the submitted question's local
   recoverability after the binding-rejection return and restore notification.

Expected future behavior: withholding the POST must leave the submitted
question recoverable without replacing a newer follow-up or consuming unrelated
recovery. The current source can lose the staged question when the genuine
empty write precedes this return. Both baseline and this candidate retain this
ordering. A same-owner connection-identity invalidation is another theoretical
guard-return ordering; existing public AppModel connection changes reset the
draft session, so do not manufacture a private identity mutation or claim that
an intentional session reset must preserve drafts.

The candidate preserves a follow-up already persisted during preflight. It also
permits a changed, unsaved local draft to flush against the initiating editor's
captured successful staging write. Any unrelated newer storage write still
rejects that flush. Ordinary final-key preservation requires the loaded draft
revision to remain current unless this exact submission provenance applies.
These are source-level guarantees pending native CI/runtime validation.

Pending whitespace counts as a changed local draft for the lifecycle flush.
The existing automatic recovery policy still treats paired local/stored
whitespace as empty and may restore a failed submitted message afterward.
Neither these controls nor a hidden-editor test prove that SwiftUI suppresses
later change callbacks after disappearance; the recovery handler has no
visibility guard.

Do not address this separate ordering by making all active edits conditional on
an older draft token: that would also reject legitimate follow-up typing after
submission staging. A future change needs its own submission/recovery policy
and controls for genuine empty edits, newer drafts, cancellation, and account
boundaries.
