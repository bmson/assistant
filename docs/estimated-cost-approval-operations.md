# Estimated-cost approval operations

The runtime feature stays off until compatible code is deployed to every budget writer. Pending proposed allowance is included in planned exposure; it is not a reservation or permission to spend. This procedure creates installation metadata and enables the review flow. It never approves a request, clears a hold, or calls a model for verification.

## Protected deployment

The existing production workflow accepts `estimated_cost_release_profile` and, for enable mode, `estimated_cost_drain_packet`. The strict nonsecret profile is defined by `infra/gcp/estimated-cost-release-config.mjs`. It binds the exact Git source, production project, installation, owner, existing OpenRouter secret identity, one positive numeric secret version, and a review window of at most 30 minutes. `latest` and credential payloads are invalid. Enable mode additionally binds the canonical baseline, compatible writers and drain receipt digests.

First release all five compatible images with a `compatible-off` profile. The protected preflight independently reads the current service and immutable revision bindings, project identity and enabled Secret Manager version metadata. Agent staging preserves the existing secret identity while pinning its version; JSON uses a separate environment-assignment delimiter. Native web creation applies the same bounded configuration. Candidate readback checks the actual immutable revision, including the secret reference. The provider-source manifest's release must match the image's `BUILD_SHA`.

When Cloud Run reports a platform-specific child instead of the requested OCI index, the shared fixed-repository resolver verifies the exact parent/child bytes and fresh native container status before semantic template comparison. Raw service/revision hashes, signature/source verification and approval remain independent checks; neither image string is rewritten in retained native evidence.

For activation, use the existing reviewed disabled-bootstrap/recovery procedure to close the compatible pair and hold delivery. Keep both services paused with no reachable aliases, the queue and all three schedulers paused, Pub/Sub delivery detached, and all three jobs free of active or uncertain executions. The baseline verifier reads complete bounded task and execution lists. It binds the five native image digests to a reconstructed release manifest and cryptographically verifies each image's workflow identity, issuer and source with the fixed Cosign registry verifier. An asserted hash or matching pair of snapshots alone is not accepted as proof of those observations.

After provisioning the baseline below, dispatch the protected paired release at the same reviewed source with an `enable` profile and the exact small drain packet. Preflight reads the canonical immutable baseline and its same-transaction marker, checks the unchanged census, repeats the native writer/drain and signature checks, then writes a private receipt bound to that profile and workflow attempt. Forward configuration, job updates, agent promotion and native web lifecycle phases require a current receipt. Recovery remains available after expiry. If the packet expires before the next forward mutation, stop and review the current state; do not extend its time or adopt an uncertain result silently.

A subsequent deployment must explicitly refresh the source-bound profile, even when deliberately turning the feature off. Missing configuration is rejected before delivery holds are acquired. Do not roll back to escrow-unaware code while active or uncertain liabilities exist. A compatible OFF release preserves liability and receipt semantics; it does not erase financial state.

## Upgrading the retained API 3 pair

The `ordinary_api3_recovery` input applies to the compatible-OFF upgrade from the reviewed serving pair on `d6954975`. Use a fresh current snapshot of both services, a current compatible-OFF profile and a signed full Firestore build for the exact main commit. Keep cleanup disabled during this operation. The normal spending activation on the new source uses its own drain and baseline.

The protected job reads two specific generations from the reviewed evidence bucket. The first identifies the agent and web images of the existing revisions. Traffic recovery uses those existing revisions. The second records an isolated restore of each replacement worker image. Worker recovery uses digest-pinned images in the recovery repository. The workflow checks their availability and the three live job configurations before changing the release. A partial or uncertain update requires native readback before any retry.

Retain complete runnable copies of the current, candidate and recovery images, including their manifests, configs, layers, attestations and signature evidence. Before removing a retention tag or scheduling registry cleanup, verify that each active service and job still has a retrievable recovery image from persistent storage. Keep the signed identity records and rehearsal receipts alongside the image references.

## Baseline provisioning

`scripts/estimated-cost-baseline-operator.ts` uses the existing verified human account, fixed `bmson-assistant` / `assistant-production` target, exact clean main source, current recovery/index inventory and reviewed native service snapshot. It refuses credential overrides, impersonation and alternate targets. All operator files must be bounded, private, regular files; retain them outside the repository. No new IAM grant or credential is part of this command.

Set `ESTIMATED_COST_LOCAL_OPERATOR` to the already authenticated `bmson@bmson.com`, `ESTIMATED_COST_RELEASE_SHA` to the exact reviewed main SHA, `OWNER_RELEASE_BOOTSTRAP_RECEIPT` and its reviewed SHA to the current snapshot, and `ESTIMATED_COST_BASELINE_OUTPUT_DIRECTORY` to a private directory. Select a mode with `ESTIMATED_COST_BASELINE_MODE`, then run `pnpm exec tsx scripts/estimated-cost-baseline-operator.ts`.

- `inspect` records the complete liability census without writing the datastore.
- `observe-drain` uses the private reviewed release manifest, pinned local Cosign executable/hash and existing isolated registry credentials to write a proposed drain packet. Review that packet and bind its digest into the reviewed current bootstrap before continuing.
- `prepare` consumes that exact private drain packet and writes a proposed baseline/witness packet. Review its digest, frozen reservation IDs and amounts, target, owner, source, cutoff and expiry.
- `apply` consumes the exact reviewed packet and digest. It records intent before one conditional create. If the response is uncertain, it only reads back the same canonical operation; it never retries with a new nonce.
- `readback` recovers the exact original packet's receipt after expiry or a later compatible release, subject to current owner/privacy checks. It does not revive expired write permission.

The command's exact file inputs are declared in its implementation (`ESTIMATED_COST_BASELINE_MANIFEST_FILE`, `ESTIMATED_COST_BASELINE_DRAIN_FILE`, `ESTIMATED_COST_BASELINE_PACKET_FILE`, `ESTIMATED_COST_BASELINE_REVIEWED_PACKET_SHA256`, and the local Cosign/registry inputs). Do not publish the packet contents in PRs or logs. Enable preflight can verify the canonical baseline receipt directly; original packets remain required for apply and uncertain-write recovery.

Provisioning freezes only eligible unapproved unknown attempt reservations with exact amounts. It preserves every reservation status, amount and ledger hold. Active held/dispatching reservations, unexpired grants, malformed/incomplete census, source/owner/privacy changes or CAS drift refuse the write. Firestore's native update timestamp also proves an eligible row was already unknown before the cutoff; a later transition remains counted but is excluded. PostgreSQL's historical cutoff depends on the independently verified operator witness rather than a native update timestamp.

## Evidence boundaries

Local/emulator tests and synthetic client renders do not establish deployment or user acceptance. Record exact source, CI, image, operator proposal/readback and actual serving revision separately. No provider billing query or real approve/decline action is needed for infrastructure verification.

Portable PostgreSQL exports declare the five installation-bound estimated-cost authority tables in runtime-exclusion version 2 only when every one is empty in the same read-only snapshot. Nonempty authority state refuses export pending a separately implemented portability path. Existing version 1 bundles remain readable; ordinary cost reservations retain their existing portable treatment.
