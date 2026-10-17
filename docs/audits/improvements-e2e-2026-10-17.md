# Improvements workflow: live verification, October 17, 2026

Status: **end-to-end acceptance remains open**. A live complaint was discovered and a real coding session ran, but the tested app workflow has not yet produced a pull request. Do not substitute the implementation PR for an autonomous worker PR.

## Live installation

The verified web release was `d8709714ffaea452e66748c677658210e7ee42d0`, using Firestore. Repair automation was enabled with the OpenAI-hosted worker, the configured `gpt-6.1-sol` coding model, and dedicated coding/publisher credentials. The owner's existing GitHub MCP connection was ready.

The initial repair overview contained 19 failed, 19 blocked, five dismissed and one resolved reports. Several failures had real hosted session identities. Generic presentation concealed recorded sandbox setup failures, and the existing ready-for-review gate checked CI without an independent model patch review.

## Observed scenarios

| Scenario | Observed result |
| --- | --- |
| Convert a real nightly suggestion into a repair | Proposal `0108367d-8d8a-53e6-8227-085139b2f00e` created issue `28167b58-53e2-5929-a687-98e29d10a679`. |
| Repeat the conversion | Returned the same issue; no duplicate coding authorization. |
| Automatic coding | The minute sweep investigated and dispatched a real hosted session. Publication refused the returned patch because it included duplicate or protected paths. No PR was created. Cleanup completed. |
| Submit an actual chat complaint | A synthetic complaint about missing model-routing proposal details was automatically captured as issue `a498a36e-6a45-5d89-a0dc-a5ed82e1ed5b`, in conversation `1bb3fe48-7360-4225-8e0b-8c1f6b802959`. |
| Run the new complaint | The authenticated Run now action was accepted. Investigation then blocked on the installation's model budget. |
| Read repository source through the actual saved MCP connection | The new reader successfully fetched `packages/application/src/workspace-improvements.ts` and `apps/web/lib/server.ts` from `bmson/assistant`. Source excerpts were bounded to 4,000 characters per file. This used the implementation in this branch from a local verification harness, rather than a deployed agent revision. |

The old Gmail suggestion was stale: the current source already bounds long query receipt identifiers. Its earlier production telemetry remains real evidence of the historical failure. The test must not manufacture a new Gmail fix merely to obtain a PR.

The shared production daily cap was $4. At the second budget snapshot, actual spend was $2.315308 and reservations were $1.679534, leaving $0.005158 unreserved. The cap was not changed; an optional request to raise it to $10 was sent to the owner. Existing model-budget and protected-path boundaries were retained.

## Changes prepared

- Recognize direct complaints naming the app or common UI features while excluding quoted, hypothetical, unrelated and opted-out text.
- Supply bounded source inspection through the owner's ready GitHub MCP connection before coding dispatch. Reads target the configured repository; original feedback and private audits are not sent to MCP.
- Require independent review of the exact published GitHub diff through the installation's configured reasoning model, after executable CI and before draft promotion.
- Preserve the model identity, verdict, summary and reviewed commit. Recheck the PR head after model review; unavailable review keeps the draft pending and rejected review keeps it out of the ready queue.
- Show the review in existing diagnosis views, clear previous review/source evidence on retry, and explain known sandbox/protected-patch failures without exposing arbitrary provider errors.

These changes require merge and release before the normal production agent uses them. They do not automatically merge or deploy a repair.

## Remaining acceptance

Resume the captured model-routing complaint once budget permits. Observe source inspection, a hosted patch with a meaningful test, a draft PR against `bmson/assistant`, successful required CI on that exact commit, independent model review, draft promotion and the Improvements review suggestion. Record the actual worker PR URL and exact commit before declaring the workflow complete. The owner retains the merge decision.
