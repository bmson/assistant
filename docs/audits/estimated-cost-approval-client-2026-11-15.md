# Estimated spending permission: client and application review

The web client keeps a costly request waiting independently. Its proposed allowance appears as planned cost, separately from recorded spending and reserved or unresolved estimates. Approve and decline apply to the named original request. No composer state or active send slot is owned by the card.

The card shows the next-step estimate, cumulative allowance, quote expiry, decline consequence, and the historical-estimate exception. It uses the shared neutral decision surface with nested blocks. Exact amounts retain nonzero microdollars. Expired unused authority is visibly expired without implying already-started work stopped. Current accounting is a separate server-provided tracking snapshot with a visible observation time. Missing values stay unavailable, and a failed newer read removes the old snapshot from approval eligibility. Financial context changes require a fresh estimate before approval. Quoted ceilings remain explicitly historical.

The local journal retains an exact explicit decision before POST. An uncertain outcome is recovered through that decision's receipt without replaying it. A canonical request read is distinct from confirmation of this client's decision. Scope changes and later quotes cannot overwrite a newer draft or borrow another request's decision.

Executed checks:

- 45 focused tests passed across web journal/transport, transcript controls, mounted client interactions, and application orchestration. Includes clock-crossing expiry, changed session, later quote, storage failure, ambiguous response, exact receipt recovery, failed canonical read, null tracking, A moving from pending to held after B spends without double counting, and requiring a fresh quote after a confirmed stale decision. New quote revisions replace obsolete full review cards for the same operation without hiding an independent request or newer chat text.
- Web and application typechecks passed. Design and QA reviewed the changed source; no additional actionable concerns remained within their reviewed scope.
- Six synthetic browser captures passed at widths 320, 390, and 1280 in light and dark appearance, using the actual component and shared CSS. No viewport overflow or page errors were observed. The browser permitted loopback requests only.
- A synthetic interaction left A's decision unconfirmed, completed independent B with its newer draft preserved, then read A's exact receipt with only one decision POST. This verifies client behavior against a fixture; it does not verify server parking, durable financial accounting, or provider spending.

The [manifest](assets/estimated-cost-approval-2026-11-15/manifest.json) binds source hashes, captures and retained logs. [Phone light](assets/estimated-cost-approval-2026-11-15/390-light.png), [narrow dark](assets/estimated-cost-approval-2026-11-15/320-dark.png), and [independent B with uncertain A](assets/estimated-cost-approval-2026-11-15/390-recovery-b-completed.png) illustrate the synthetic states.

The application service defaults new authority off. Compatible off mode keeps canonical reads, exact receipt recovery, and decline available. Preparation validates identity and shape; persistence retains transactional financial and task authority. The service never retries an uncertain decision.

This is partial implementation evidence. Concrete PostgreSQL/Firestore request transactions, trusted preparation, runtime parking/resumption, deployment composition and end-to-end acceptance remain in progress. No real spending decision, provider request, production deployment or phone acceptance was performed by these checks.
