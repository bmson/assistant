# Request-specific approval for estimated cost pressure

## Intended behavior

A request that needs cost permission waits independently for approval or denial. The owner can continue typing, speaking, navigating and submitting other eligible requests. Pending permission must not reserve funds or occupy the active conversation slot.

The budget display distinguishes recorded usage costs, active reservations, uncertain historical reservations, and amounts awaiting approval. A planned-exposure total may include all of them, but pending estimates are not described as money spent or committed. Incomplete totals remain visibly incomplete.

Approval authorizes a bounded cumulative internal allowance for the named original request. It is not a blanket policy change and is not an approval for tools or external actions. The request may ask again if its allowance is exhausted. Provider charges are not guaranteed by an internal estimate.

## Eligibility and financial scope

- The server creates a quote from trusted pricing, routing and ledger data without a model call. It never parses free-form reason text or accepts a model-authored amount as authority.
- The quote separates the next blocked attempt's estimate from the maximum cumulative request allowance. The proposed allowance is bounded by the task's existing remaining allowance and applicable recorded-spend and committed-capacity headroom.
- Existing task, daily, monthly, provider and tool restrictions remain enforced, including only the existing owner-reply policy where it already applies. Persistent cap settings are unchanged.
- The exception may accept explicitly identified historical/unapproved unknown reservations as uncertain exposure. It must not discard known active work, another approved request's capacity, or new grant-linked uncertain outcomes. Existing reservation status and amount remain unchanged.
- Freeze the eligible baseline by reservation identifier and amount, and validate every record's current unknown status and historical, unapproved provenance. An aggregate alone is insufficient. Settlement, release, status changes, linkage changes or an incomplete read invalidate that baseline; its old value cannot be discounted again.
- The quote shows the original request, recorded costs, relevant limits and effective ceilings, uncertain holds, the proposed allowance, projected gross exposure and the consequence of approval. Insufficient capacity for reasons other than eligible uncertain-estimate pressure retains a clear ordinary denial.
- All accounting uses checked integer microdollars. Unsupported currency, malformed amounts, incomplete baseline reads and unrecognized provenance fail closed.

## Durable authority and accounting

- Quotes and grants bind the installation, authenticated owner, original operation, task, request fingerprint, pricing/routing and policy revisions, budget periods and quote revision. Different requests cannot borrow each other's authority.
- A quote normally expires after ten minutes. An approved unused allowance normally expires thirty minutes after approval, subject to any stricter bound required by its period or policy. Expired work remains inspectable and may request a fresh estimate without spending.
- Only an explicit structured owner decision can approve. Generic chat prose, model output, autonomy settings, standing tool grants and GET requests cannot mint cost authority.
- Approval, its same-operation decision receipt, and creation of the allowance escrow commit atomically. Duplicate decisions cannot allocate another allowance. A different body under the same operation identifier is rejected.
- Each underlying billable attempt has a distinct idempotent reservation identity. Transferring capacity from escrow to that attempt is atomic and preserves total held capacity. Concurrent requests cannot reserve the same headroom or consume the same grant balance.
- Settlement accounts for actual recorded usage and remaining allowance without double counting. Completion, cancellation or expiry may release only unused, undispatched capacity. Dispatched or unknown outcomes remain held and protected.
- Decline stops only the selected waiting request. Approval-versus-decline races have one canonical winner. Unknown transport outcomes are resolved through the exact decision receipt rather than a new spending operation or a generic refresh.
- A changed request, policy, pricing revision, baseline or approved exposure requires a fresh review and renewed consent. No implicit grant extension or automatic additional approval is allowed.

## Independent conversation lifecycle

- Parking a request persists its quote and checkpoint, releases its worker lease and returns a durable pending-decision receipt before the client releases the active send slot.
- Approving an older request resumes its original task and checkpoint under its own lease and operation. It must not adopt the latest message, consume another request's allowance, clear a newer draft, or overwrite a later turn.
- The sequence “A waits, B runs, A is approved/declined/expires” must work in typed chat and Talk. Active sends and genuinely unresolved submissions retain their existing same-operation protection.
- A pending allowance contributes to the pending subtotal exactly once. Approval moves it to active capacity; denial, cancellation or expiry removes the current pending amount exactly once. An expired estimate remains distinguishable from a current planned amount.

## Rollout and verification

All writers, dispatchers, settlement and stale-cleanup paths must understand escrow before the feature is enabled. `ESTIMATED_COST_APPROVAL_ENABLED` defaults to false until compatible services and jobs are deployed and old writers are drained. The shared profile capability also excludes restore rehearsals and a fenced PostgreSQL writer. Explicit client capability is required before a chat request can be parked. A compatible feature-off recovery path must preserve active and unknown liabilities. Downgrade to escrow-unaware code is prohibited while incompatible live state exists.

Required checks include PostgreSQL and Firestore parity; quote and decision expiry; exact receipt recovery; duplicate and conflicting decisions; concurrent grants, reservations, dispatch and cleanup; settlement conservation; pricing/policy/source drift; owner and installation changes; pending totals; and independent conversation sequences. Native and web clients need explicit pending, submitting, approved, declined, expired, changed, unavailable and unconfirmed states.

Implementation and merge/deploy are authorized by the user's current request. Approving a real request, spending on the owner's behalf, provider billing access, clearing historical holds and unrelated production activation are not authorized. Source review, test results, merge, deployment, serving and observed user-flow acceptance remain separate evidence.
