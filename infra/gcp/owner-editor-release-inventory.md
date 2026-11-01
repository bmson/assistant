# Read-only basic editor release prerequisites

This source supports the five-command web release: create a person, update identity, add a family relationship, correct a family relationship, and correct owner memory. Person removal and family removal remain excluded. It observes production metadata through the existing protected GitHub WIF identity; it does not initialize, rotate, enable, or edit anything. Permission denial means UNKNOWN. No new credentials, IAM changes, or local credential fallback are permitted.

## Automatic release gate

Merging any successful main push still triggers the existing automatic deployment. There is no path exemption, trigger change, or skipped CI in this patch. Therefore this source should be bundled into the web feature candidate for one main merge. An inspection dispatched after merging is not a reliable prerequisite: concurrent job ordering does not guarantee inspection runs first.

The deploy job runs `--release-preflight` before invoking the Firestore delivery guard. The candidate's `infra/gcp/release-contracts.json` must declare `components.web.ownerEditorV1` as exactly these five strings:

```json
["create_person", "update_person_identity", "add_family_relationship", "correct_owner_family_relationship", "correct_owner_memory"]
```

The declaration is source, not an operator input. A present `apps/web/lib/owner-editor-runtime.ts` with an absent or different declaration fails closed. A declaration without that runtime also fails. Older source with neither is unaffected. This bounded feature release requires the observed agent Firestore path and the agent/web pair; an agent selecting PostgreSQL (or web-only selection) fails before release execution. PostgreSQL delivery of this runtime needs its own reviewed readiness path and is not silently allowed by a public web Firestore observation. Review must independently verify the actual server command allowlist matches the declaration.

The gate requires matching explicit serving owner/workspace targets on both services, verified serving revisions, exact 197-index parity, a qualifying PITR/backup observation, and stable repeated observations of a singleton owner plus a READY epoch bound to the current privacy generation. Missing, disabled, changed, denied, malformed, or UNKNOWN prerequisites stop the job. Failure occurs after image build/sign/push, but before the delivery guard pauses ingress, changes workers, or invokes candidate rollout. There is no epoch creation or rollback mutation on this failure path. Existing restore handles an absent guard receipt as a no-op. Failures after release execution retain the existing guard restoration behavior; this patch does not replace it.

The deploy job's SDK is pinned to gcloud 576.0.0 for the same audited listing semantics as inspection. No change is made to cleanup, release triggers, branch protection, CI requirements, traffic behavior, or production authorization. A positive observation is a prerequisite only; it does not qualify retained recovery images, prove drain/restore, authorize activation, or establish user-visible delivery.

## Independent inspection

`Observe owner editor release prerequisites` remains dispatch-only on trusted main, first attempt only, in the existing production environment and `production-deploy` concurrency group. It has no target/action parameters. `--verify-source` runs before cloud authentication. The pinned manifest is checked out as data only from `04c17b04ab9d76d005b04121927c189baa6edaf9`; SHA256 must be `5baaca10aa089b2eac771de7c9086317206bd937d09a89ea6e937ac945e03cd1`. Release preflight checks the candidate's own manifest against those identical bytes. The fixture contains 197 indexes. Missing one approved index is a reviewable classification, never permission to create it.

WIF verification requires the explicit external-account file created in the workspace by the pinned authentication action, the configured audience and exact configured service-account impersonation endpoint. It does not discover default credentials or prove independent caller provenance. Cloud SDK commands only list global composite/custom-field indexes and acquire the short-lived access token. They add no collection-group filter or limit. TTL-only inherited field inventory is not claimed. The alternative injected REST-only test path cannot prove global coverage.

Other cloud reads are fixed-target GETs for `bmson-assistant`, `us-west1`, database `assistant-production`: database/recovery metadata, agent/web services, and their actual serving revisions. Owner metadata is read only when both services and their serving revisions contain matching explicit plaintext `ASSISTANT_WORKSPACE_ID` and `FIRESTORE_AGENT_ID`. Missing or secret-referenced values are UNKNOWN; no default owner or workspace is guessed.

Within the base64url-encoded installation path, only these three field-masked resources are read twice:

- `agents?pageSize=2&mask.fieldPaths=id`, to verify exactly one owner and its encoded document identity.
- The encoded owner's `privacyErasureJobs` document, masked to `agentId,status,generation` plus the API's update timestamp.
- The encoded `maintenanceCursors` document named `owner-editor-epoch:<owner>`, masked to `name,cursor`.

The privacy digest matches the V1 helper, including native seconds/nanoseconds. A missing privacy job is a distinct valid generation token; active or malformed privacy metadata cannot establish readiness. Epoch state must have exactly the four V1 keys `ownerId,epoch,ready,privacyGenerationDigest`. Matching repeated reads establish observation stability, **not an atomic snapshot**. Transactional command admission still validates current authority at write time.

Redirects are rejected. The original collector permits at most 128 fixed-target REST requests, eight pagination pages of at most 100 records, 2 MiB per response and 8 MiB total. Owner metadata permits at most six additional requests, 16 KiB each. Each request/CLI command has at most eight seconds within a shared absolute 60-second collector deadline, including token acquisition. CLI output is bounded to 2 MiB per command and 8 MiB total. Workflow timeout is five minutes including setup. Cancellation is best effort. There are no collector retries or fallback identities.

PITR observations require exact database/location/incarnation identity, valid earliest coverage and bounded retention. Backup fallback requires matching database name and UUID, READY status, an unexpired snapshot no older than 26 hours. Exact timestamp strings are retained; directional comparison bounds conservatively preserve sub-millisecond precision. Observation time is not an operation checkpoint. Proposed whole-minute PITR snapshots remain unqualified and expiry is not guaranteed. Neither PITR metadata nor a backup listing proves restoration or a compatible retained recovery runtime.

The receipt is capped at 64 KiB. It retains allowlisted release metadata and configuration hashes, readiness booleans and fixed reasons. It omits raw service bodies, owner/workspace identifiers, privacy generation, epoch/cursor contents, credentials, and user records. It explicitly denies traffic, mutation, maintenance, and recovery-pair authority. Errors outside metadata observation may fail the job without a receipt; that also establishes no readiness.

## Missing epoch: separate reviewed initializer

See `owner-editor-v1-initialization-plan.md`. No initializer executable or production write is included. A missing epoch causes an automatic release failure before rollout, allowing inspection and a concrete, separately reviewed initialization decision. PostgreSQL migrations and V2 removal tables are not requirements for an observed Firestore basic-five release.
