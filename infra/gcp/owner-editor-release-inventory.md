# Read-only basic editor release prerequisites

This source supports the bounded person-note web release: create a person, update identity, add a family relationship, correct a family relationship, correct owner memory, and create a plain-text note about an existing person. `create_owner_memory` is person-scoped and does not enable standalone memories. Person removal and family removal remain excluded. It observes production metadata through the existing protected GitHub WIF identity; it does not initialize, rotate, enable, or edit anything. Permission denial means UNKNOWN. No new credentials, IAM changes, or local credential fallback are permitted.

## Automatic release gate

Merging any successful main push still triggers the existing automatic deployment. There is no path exemption, trigger change, or skipped CI in this patch. Therefore this source should be bundled into the web feature candidate for one main merge. An inspection dispatched after merging is not a reliable prerequisite: concurrent job ordering does not guarantee inspection runs first.

The deploy job runs `--release-preflight` before invoking the Firestore delivery guard. The candidate's `infra/gcp/release-contracts.json` must declare `components.web.ownerEditorV1` as exactly these six strings:

```json
[
  "create_person",
  "update_person_identity",
  "add_family_relationship",
  "correct_owner_family_relationship",
  "correct_owner_memory",
  "create_owner_memory"
]
```

The declaration is source, not an operator input. A present `apps/web/lib/owner-editor-runtime.ts` with an absent or different declaration fails closed. A declaration without that runtime also fails. Older source with neither is unaffected. This bounded feature release requires the observed agent Firestore path and the agent/web pair; an agent selecting PostgreSQL (or web-only selection) fails before release execution. PostgreSQL delivery of this runtime needs its own reviewed readiness path and is not silently allowed by a public web Firestore observation. Review must independently verify the actual server command allowlist matches the declaration.

The gate requires matching explicit serving owner/workspace targets on both services, verified serving revisions, exact release-candidate index and field override parity, a qualifying PITR/backup observation, and stable repeated observations of a singleton owner plus a READY epoch bound to the current privacy generation. Missing, disabled, changed, denied, malformed, or UNKNOWN prerequisites stop the job. Failure occurs after image build/sign/push, but before the delivery guard pauses ingress, changes workers, or invokes candidate rollout. There is no epoch creation or rollback mutation on this failure path. Existing restore handles an absent guard receipt as a no-op. Failures after release execution retain the existing guard restoration behavior; this patch does not replace it.

The release preflight checks the manifest from the selected release checkout. The current candidate pin is SHA-256 `f2ddade854dca286c13740fe79b29b43feb243e5548b81c2157f2e030f6fb98a` with 204 composite indexes and 19 field overrides. The predecessor remains pinned under `release-candidate-pre-signals` at SHA-256 `6d865448c246fd9ac1bcbe179204becfb23fabfee0b45369103b1352345fc553` with 200 composite indexes and 19 field overrides. Current release preflight selects only the current candidate pin. The protected workflow checks the checkout against the selected release SHA and the receipt records that SHA alongside the manifest digest. The reviewed local owner-editor and estimated-cost operators use the same candidate pin after their existing source checks. A manifest change requires an explicit review and update of the candidate pin and regression fixture coverage.

The deploy job's SDK is pinned to gcloud 576.0.0 for the same audited listing semantics as inspection. No change is made to cleanup, release triggers, branch protection, CI requirements, traffic behavior, or production authorization. A positive observation is a prerequisite only; it does not qualify retained recovery images, prove drain/restore, authorize activation, or establish user-visible delivery.

## Independent inspection

`Observe owner editor release prerequisites` remains dispatch-only on trusted main, first attempt only, in the existing production environment and `production-deploy` concurrency group. It has no target/action parameters. `--verify-source` runs before cloud authentication. The pinned manifest is checked out as data only from `04c17b04ab9d76d005b04121927c189baa6edaf9`; SHA256 must be `5baaca10aa089b2eac771de7c9086317206bd937d09a89ea6e937ac945e03cd1`. This independent observer fixture contains 197 composite indexes. The maintenance collector uses the same historical pin and still stops if exact parity with it cannot be established. Missing one approved index is a reviewable classification, never permission to create it.

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

## Archived API 1 runtime observation

Dispatch the inventory workflow in `archived-runtime` mode for the reviewed agent and web pair from build `44263661117`. The job requires the same first-attempt, exact-main source and configuration bindings as the prerequisites job. It validates them before authenticating. Configure the protected production environment variables `OWNER_ARCHIVED_RUNTIME_GENERATION` and `OWNER_ARCHIVED_RUNTIME_OBJECT_SHA256` with the exact decimal generation and lowercase SHA-256 of the reviewed private object. The job reads only that generation of `gs://bmson-assistant-reviewed-release-evidence/owner-archived-runtime/44263661117/v1.pack` and uses the existing WIF identity. The release owner must provision that private object and grant scoped read access separately. The job also needs read access to the fixed Cloud Run service/revision resources.

The object consists of one canonical UTF-8 JSON header line, followed by the member bytes in the order listed. The header is `{"format":1,"files":[{"path":"oci-layout","size":36},...]}` with compact serialization, keys in the indicated order, and one newline separator. Use the actual byte count for each member. The allowlist covers `oci-layout`, `index.json`, the runtime descriptor graph under `blobs/sha256`, `trusted-root.json`, `native-binding.json`, and each role's raw historical parent, original build receipt, image signature bundle, and SBOM bundle under `historical`. Use `pnpm exec tsx scripts/owner-archived-runtime-pack-local.ts --pack PACK_DIR NEW_OUTPUT` to create the bundle offline. It writes a new private file and prints its byte count and object SHA-256. The observer independently pins the SHA-256 of the compact JSON list of every unpacked file's relative path, byte length and SHA-256, sorted by ASCII path. A changed pack or native baseline requires a reviewed source update.

The hosted job verifies the generation-bound object bytes, full unpacked pack, historical Sigstore provenance and exact native pair. It rereads the services to detect drift, deletes its private temporary directory when the command settles and uploads only a sanitized receipt. An interrupted runner may omit a receipt. No database access is needed. The receipt identifies the observer run, archive object binding, original release and pack. Service startup, restoration from a recovery target and promotion each require separate evidence. The separate restore-target mode is documented in `api3-recovery-qualification.md`.

For a controlled operator replay, the standalone CLI also accepts a reviewed private pack at `$RUNNER_TEMP/owner-archived-runtime-pack` with the approved platform-specific Cosign executable at `.artifacts/archived-runtime-tools/cosign` in the checkout.
