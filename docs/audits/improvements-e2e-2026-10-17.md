# Improvements workflow: live verification, October 17, 2026

Historical checkpoint at **23:51 UTC**: end-to-end acceptance remained open. A live complaint was discovered and a real coding session ran, but publication exposed a missing GitHub permission. Subsequent results, worker PR links, final checks and restored settings are tracked in the [implementation PR's live-verification section](https://github.com/bmson/assistant/pull/594). Do not substitute the implementation PR for a worker-created repair PR.

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
| Ordinary chat handling of the same complaint | The separate chat task looked for repository paths in the owner's file workspace, then stopped. Its actual recorded spend was $0.092453. Explicit code-repair complaints now receive the tracked repair receipt directly, preventing that duplicate planner path. |
| Read repository source through the actual saved MCP connection | The new reader successfully fetched `packages/application/src/workspace-improvements.ts` and `apps/web/lib/server.ts` from `bmson/assistant`. Source excerpts were bounded to 4,000 characters per file. This used the implementation in this branch from a local verification harness, rather than a deployed agent revision. |

The old Gmail suggestion was stale: the current source already bounds long query receipt identifiers. Its earlier production telemetry remains real evidence of the historical failure. The test must not manufacture a new Gmail fix merely to obtain a PR.

The shared production daily cap was $4. At the second budget snapshot, actual spend was $2.315308 and reservations were $1.679534, leaving $0.005158 unreserved. The owner explicitly authorized a temporary increase to $10, applied through the authenticated costs API at 23:33 UTC. Restore the original $4 cap after verification. Existing model-budget and protected-path boundaries were retained.

The next production investigation returned placeholder text (`...` and `{`) instead of a usable brief. This is a model-output failure, rather than a missing owner description. The candidate now records the failure and its available accounting, preserves the original report, and directs recovery toward the configured models. It also rejects placeholder patch-review summaries.

A local candidate verification task (`96528a4e-32db-4ca2-8953-6eaea2a3ebb8`) then retried the actual captured report through the real Firestore repositories and ModelRouter. An operator selected the already enabled Kimi K2.6 model for that call; the existing GPT-OSS fallback produced the usable brief. The durable model ledger records `openai/gpt-oss-120b`, 1,156 input tokens, 474 output tokens, and $0.000120 for the successful call. Global reasoning-role settings were not changed. The task used a normal owner-scoped lease and $0.75 task budget; model validation, shared budgets, report claims and protected-file gates remained active.

That candidate cycle recorded real GitHub MCP source reads of both requested files and dispatched hosted session `sess_0a41674af0350bd3006ad406ebaf50819692ca2e4b5bde1970`, pinned to source commit `7bf7408429fe62e502d5aa45fe33e19a472f9f71`. The coding model remained the installation's `gpt-6.1-sol`. This is candidate execution against live services; the candidate implementation has not been released to the ordinary production agent.

The completed coding attempt reached publication but GitHub rejected blob creation with HTTP 403, `Resource not accessible by personal access token`, requiring `contents=write`. The dedicated publisher could read the repository and its account-level `permissions.push` was true; neither established that the token could publish. Its rate limit was healthy. The candidate now checks Contents write with an unreferenced empty blob before starting a paid coding session, and exposes a fixed, credential-free permission explanation. The token also needs Pull requests write. The owner was asked to update the existing token restricted to `bmson/assistant`; no broad CLI credential was copied into production.

The connected GitHub MCP successfully created a verification blob. A second candidate attempt used a local publication bridge to those existing MCP tools while retaining the hosted worker's patch validation, immutable source, complete comparison, draft PR and CI/review gates. This is explicitly an operator-assisted rehearsal; it does not establish that the production publisher credential is fixed. The automatic repair schedule was temporarily paused through the normal settings API during this isolated attempt and must be restored along with the daily cap. Second session: `sess_0ddd9d1e3432a9ee006ad4096a7ff88197ace384bb4b378cdc`.

The normal `runSelfImprove` review also ran against actual owner-scoped reliability signals under task `74c7565e-f350-4ddb-a56c-b10f7ed46978`. It found seven patterns and created three new advisory proposals, verified through the normal paginated Improvements API: `26694beb-2a09-588c-956b-c5216c57194c`, `2bf7febc-ac48-5bb1-b05e-40532113b670`, and `d8fe1df0-bc6a-5016-bbe5-861e5f347082`. No settings were applied. The broad workspace endpoint returned 503 during this check; the paginated Improvements section was available. Browser verification was unavailable because the app URL was blocked in the in-app browser and the native desktop was locked. API and durable-ledger observations must not be represented as visual verification.

## Changes prepared

- Recognize direct complaints naming the app or common UI features while excluding quoted, hypothetical, unrelated and opted-out text.
- Hand explicit code-repair complaints to the durable Improvements report without also running an ordinary file-workspace task. Repeated requests show the actual existing report status.
- Supply bounded source inspection through the owner's ready GitHub MCP connection before coding dispatch. Reads target the configured repository; original feedback and private audits are not sent to MCP.
- Require independent review of the exact published GitHub diff through the installation's configured reasoning model, after executable CI and before draft promotion.
- Preserve the model identity, verdict, summary and reviewed commit. Recheck the PR head after model review; unavailable review keeps the draft pending and rejected review keeps it out of the ready queue.
- Show the review in existing diagnosis views, clear previous review/source evidence on retry, and explain known sandbox/protected-patch failures without exposing arbitrary provider errors.

These changes require merge and release before the normal production agent uses them. They do not automatically merge or deploy a repair.

## Acceptance criteria after this checkpoint

Resume the captured model-routing complaint once budget permits. Observe source inspection, a hosted patch with a meaningful test, a draft PR against `bmson/assistant`, successful required CI on that exact commit, independent model review, draft promotion and the Improvements review suggestion. Record the actual worker PR URL and exact commit before declaring the workflow complete. The owner retains the merge decision.
